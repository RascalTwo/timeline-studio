// THE BROWSER SUITE. It began as a disposable harness for the playback view mode,
// in the spirit of the old `docs/original/verify.interactions.ts` — which needed a
// live deployment and an external runner, never joined an automated run, and has
// since been deleted for it. This one serves `web/` against a stub API and drives
// headless Chrome on no infrastructure, so CI runs it before every deploy.
//
//   bun scripts/playback-harness.ts            # serve, leave it up (HARNESS_PORT overrides)
//   bun scripts/playback-harness.ts --check    # serve, drive headless Chrome, exit
//
// WHY A STUB AND NOT THE REAL SERVER. Playback is a change to `web/index.html`
// only, and what it has to be proven about is the PAGE: does the chart show an
// archived document, does the socket actually close, and does the live document
// come back untouched. A stub gives that a history with known contents and a
// room it can watch open and shut, on no infrastructure. The real server's own
// behaviour is already covered by `sync-server/test/`, and pointing this at a
// real plan would mean testing against a client's delivery schedule.
import { serve } from 'bun'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { instantOfDay } from '../shared/schedule.js'

const WEB = join(import.meta.dir, '..', 'web')
const DIST = join(WEB, 'dist')

// BUILD BEFORE SERVING. web/schedule.js and web/commands.js are symlinks onto
// shared/*.js, which is generated from shared/*.ts and gitignored. Serving
// without building is how this suite would quietly assert against a scheduler
// nobody has compiled — or 404 on a fresh checkout.
//
// TWO DIFFERENT BUILDS, because the two halves ship differently. `shared/` is
// compiled by tsc and served AS FILES, unbundled and with its comments, because
// the server hashes those exact bytes (ADR 0001) and `/commands.js` is the
// protocol reference agents are told to read. The page is bundled by Vite, which
// treats those two as external for the same reason — see web/vite.config.ts.
//
// The binaries are addressed by PATH, not through `bun x`/`npx`. A bare `npx tsc`
// in web/ resolved to an unrelated package on this machine and cheerfully
// reported zero errors against nothing.
const run = (cmd: string[], cwd: string, what: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) { console.error(`build failed: ${what}`); process.exit(1) }
}
run([join(import.meta.dir, 'node_modules', '.bin', 'tsc'), '-p',
     join(import.meta.dir, '..', 'shared', 'tsconfig.json')], import.meta.dir, 'shared')
run([join(WEB, 'node_modules', '.bin', 'tsc'), '--noEmit'], WEB, 'web typecheck')
run([join(WEB, 'node_modules', '.bin', 'vite'), 'build'], WEB, 'web bundle')
// Bound to LOCALHOST EXPLICITLY and on an odd port. Bun's default binds the
// IPv6 wildcard, and any other dev server already holding `*:<port>` answers
// localhost first — which had this harness silently serving somebody else's
// page while reporting that it had started.
const PORT = Number(process.env.HARNESS_PORT || 5211)

/** A tiny plan that grows a task per version, so "did the chart change" has an
 *  answer you can count rather than eyeball. */
const planAt = (n: number) => ({
  schemaVersion: 4,
  title: 'Harness plan',
  start: '2026-01-05',
  lanes: [{ id: 'A', label: 'Team A' }, { id: 'B', label: 'Team B' }],
  // RICH ENOUGH TO DRAW THE THINGS THAT HAVE BEEN GOT WRONG. This fixture was one
  // colour, one solid fill and one soft shape, which is the kindest possible plan
  // — and it made the grid fingerprint unable to fail. Proving that: swapping the
  // bar's `backgroundColor` for the `background` shorthand is a documented bug
  // (the shorthand resets `background-image`, where the hatch lives) and the
  // fingerprint did not notice, because with `pat-solid` there was no
  // background-image either way. Every value below exists to make one of the four
  // landmines in the row loop actually appear on screen:
  //   c1+c2 on one task -> the multi-colour BANDS, which are elements and not a
  //                        linear-gradient, for exactly that reason
  //   f2 'hatch'        -> a real background-image to be erased
  //   s2 'diamond'      -> POINTED: the rim moves to .shape and the fill to an
  //                        inset .core, because a border would be clipped away
  //   t3's actuals      -> the estimate tick and its whisker
  colors: [{ id: 'c1', label: 'System', color: '#5aa9f0' },
           { id: 'c2', label: 'Second', color: '#b98bf0' }],
  // TWO BORDER VALUES, because the inspector hides a channel whose list has
  // fewer than two — one value is not a choice. A second one is what makes
  // `#bord` exist to be tested. Deliberately NOT a second lane, task or
  // milestone: the checks below count all three.
  borders: [{ id: 'b1', label: 'none', style: 'none' },
            { id: 'b2', label: 'prod', style: 'solid' }],
  fills: [{ id: 'f1', label: 'known', pattern: 'solid' },
          { id: 'f2', label: 'guessed', pattern: 'hatch' }],
  shapes: [{ id: 's1', label: 'none', shape: 'soft' },
           { id: 's2', label: 'spike', shape: 'diamond' }],
  defaults: { borders: 'b1', shapes: 's1', fills: 'f1' },
  milestones: [{ id: 'm1', label: 'Ship', date: '2026-04-01' }],
  channelLabels: { lanes: 'Team', colors: 'System', borders: 'Env', fills: 'Accuracy' },
  tasks: Array.from({ length: n + 2 }, (_, i) => ({
    id: 't' + i, label: 'Task ' + i, lane: i % 2 ? 'B' : 'A',
    // Spread across the channels rather than uniform, so both branches of every
    // one of them is drawn somewhere on the chart.
    color: i % 4 === 1 ? ['c1', 'c2'] : ['c1'],
    border: i % 4 === 3 ? 'b2' : 'b1',
    fill: i % 3 === 1 ? 'f2' : 'f1',
    shape: i % 5 === 2 ? 's2' : 's1',
    // Durations grow with the version so every save moves bars visibly.
    dur: 3 + (i % 3) + n, deps: i > 1 ? ['t' + (i - 2)] : [],
    // ONE TASK WITH BOTH ACTUALS, which is what puts the estimate tick on screen.
    // Day numbers, and well inside the plan so it is never in the future.
    ...(i === 3 ? { actualStart: 2, actualEnd: 9 } : {}),
  })),
})

const VERSIONS = Array.from({ length: 6 }, (_, i) => ({
  n: i + 1,
  at: `2026-01-${String(6 + i).padStart(2, '0')}T12:00:00.000Z`,
  note: i === 3 ? '' : `save number ${i + 1}`,
  by: i % 2 ? 'Ada' : 'Grace',
  doc: planAt(i),
}))
const LIVE = planAt(9)          // deliberately unlike every archived version
/** THE PLAN ZONE'S WALL CLOCK, NOT THIS MACHINE'S. The page stamps and captions
 *  times in the plan's `timeZone` (v6), so a check that reads the machine's own
 *  clock passes only where the two agree — on a laptop in Chicago, never on a UTC
 *  CI runner, which is where both clock checks first failed. Milliseconds read as
 *  if UTC, the representation the page's day numbers are built on. */
const PLAN_TZ = (LIVE as any).timeZone || 'America/Chicago'
const planWall = (ms = Date.now()) => {
  const p: Record<string, number> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: PLAN_TZ, hourCycle: 'h23', year: 'numeric',
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms)) p[x.type] = +x.value
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second))
}

/** THE REAL PLAN'S SHAPE, from measurements taken against it rather than invented.
 *
 *  The ordinary fixture is eleven tasks in two lanes, and that is the right size
 *  for the playback checks — six archived versions you can count rows in. It is
 *  the wrong size for everything else, and it hid things: `reorderUnits` puts it
 *  at 671 against a budget of 20,000, so it could never reach the server path at
 *  all, and the first version of the grid fingerprint could not fail because one
 *  colour and one solid fill meant there was no hatch to erase.
 *
 *  So this one is built from aggregates measured on the live 135-task plan on
 *  2026-09-07 — no names, dates or labels, just the shape:
 *
 *    135 tasks · 9 lanes of 39/28/15/12/12/10/9/8/2 · 260 dependencies, max 9
 *    durations: median 2, mean 3.2, max 15 (61 are a single day)
 *    34 tasks exempt from their queue · 23 with an actual start · 7 holidays
 *
 *  At 414,045 units it is comfortably past LOCAL_BUDGET, which is what makes the
 *  server path — and the "advice goes stale rather than recomputing" rule that
 *  hangs off it — reachable by a test at all. */
const realShaped = () => {
  const lanes = ['SRV', 'DB', 'CAB', 'NET', 'QA', 'DEV', 'IAM', 'MBR', 'OPS']
    .map((id, i) => ({ id, label: 'Team ' + id, cap: i < 2 ? 2 : 1 }))
  const sizes = [39, 28, 15, 12, 12, 10, 9, 8, 2]
  // The measured duration histogram, not a uniform spread: 61x1, 10x2, 32x3,
  // 18x5, 10x8, 4x15. A fixture whose durations are all similar never walks the
  // calendar the way a real one does.
  const durs: number[] = []
  const rep = (n: number, v: number) => { for (let i = 0; i < n; i++) durs.push(v) }
  rep(61, 1); rep(10, 2); rep(32, 3); rep(18, 5); rep(10, 8); rep(4, 15)
  const tasks: any[] = []
  let i = 0
  sizes.forEach((sz, li) => { for (let k = 0; k < sz; k++, i++) {
    // 260 edges over 135 tasks, concentrated rather than uniform — most tasks
    // have one or two, a few carry nine.
    const deps: string[] = []
    const nd = i % 17 === 0 ? 9 : i % 5 === 0 ? 3 : i > 2 ? 2 : 0
    for (let j = 1; j <= nd && i - j * 3 >= 0; j++) deps.push('t' + (i - j * 3))
    tasks.push({
      id: 't' + i, label: 'Task ' + i, lane: lanes[li]!.id,
      // Spread across the channels so both branches of each are drawn.
      color: i % 4 === 1 ? ['c1', 'c2'] : ['c1'],
      border: i % 4 === 3 ? 'b2' : 'b1',
      fill: i % 3 === 1 ? 'f2' : 'f1',
      shape: i % 5 === 2 ? 's2' : 's1',
      dur: durs[i % durs.length], deps, ms: i % 2 ? 'm1' : 'm2',
      ...(i % 4 === 0 ? { noQueue: true } : {}),
      ...(i % 6 === 0 ? { actualStart: 1 + (i % 20) } : {}),
      ...(i % 12 === 0 ? { actualEnd: 6 + (i % 20) } : {}),
    })
  } })
  return {
    schemaVersion: 4, title: 'Real-shaped harness plan', start: '2026-01-05',
    lanes,
    colors: [{ id: 'c1', label: 'System', color: '#5aa9f0' },
             { id: 'c2', label: 'Second', color: '#b98bf0' }],
    borders: [{ id: 'b1', label: 'none', style: 'none' },
              { id: 'b2', label: 'prod', style: 'solid' }],
    fills: [{ id: 'f1', label: 'known', pattern: 'solid' },
            { id: 'f2', label: 'guessed', pattern: 'hatch' }],
    shapes: [{ id: 's1', label: 'none', shape: 'soft' },
             { id: 's2', label: 'spike', shape: 'diamond' }],
    defaults: { borders: 'b1', shapes: 's1', fills: 'f1' },
    milestones: [{ id: 'm1', label: 'Ship', date: '2026-06-01' },
                 { id: 'm2', label: 'Later', date: '2026-09-01' }],
    channelLabels: { lanes: 'Team', colors: 'System', borders: 'Env', fills: 'Accuracy' },
    workweek: [0, 1, 1, 1, 1, 1, 0],
    holidays: ['2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03',
               '2026-09-07', '2026-11-26', '2026-12-25'],
    tasks,
  }
}
const BIG = realShaped()

/** Which plan the stub is serving. Flipped by `/__mode`, so the ordinary checks
 *  run against the small plan and the expensive-plan behaviour gets its own pass
 *  without a second fixture file or a second harness. */
let serving: 'small' | 'big' = 'small'
// TWO FAILURE PATHS, SERVED ON DEMAND. Both banners they raise are the page's
// answer to "something upstream is wrong and I cannot answer the question you
// opened me to answer", and neither had ever been drawn by a test — which is how
// six one-shot banners came to be rewritten with nothing watching.
let waking = false, cycle = false, gone = false, sortme = false, stale = false, noworker = false,
    slowsearch = false
/** A plan that cannot be scheduled. Two tasks waiting for each other is the whole
 *  of it, and `sched()` throws rather than returning a plan with no dates. */
/** A plan whose LANES are in the wrong order: `tx` sits in the first team and
 *  waits for `ty` in the second, so the one dependency here points UP. Sorting
 *  has an answer, and it is the swap.
 *
 *  It exists because neither other fixture can exercise the action. The small
 *  plan's every dependency runs t(n) <- t(n-2), which is the SAME lane, so
 *  `laneOrder` correctly says "nothing to sort by"; the big one is already
 *  optimal — "0 of 111 dependencies point up". A check written against either
 *  passes down the "already in the best order" branch and proves nothing about
 *  the button. */
const SORTABLE = () => ({ ...LIVE, milestones: [], tasks: [
  { id: 'ty', label: 'Upstream', lane: 'Y', color: ['c1'], border: 'b1', fill: 'f1',
    shape: 's1', dur: 3, deps: [] },
  { id: 'tx', label: 'Downstream', lane: 'X', color: ['c1'], border: 'b1', fill: 'f1',
    shape: 's1', dur: 3, deps: ['ty'] },
], lanes: [{ id: 'X', label: 'Team X' }, { id: 'Y', label: 'Team Y' }] })

const CYCLIC = () => ({ ...LIVE, tasks: [
  { ...LIVE.tasks[0], deps: ['t1'] }, { ...LIVE.tasks[1], deps: ['t0'] }, ...LIVE.tasks.slice(2)] })
const livePlan = () => { const d = cycle ? CYCLIC() : sortme ? SORTABLE() : serving === 'big' ? BIG : LIVE
  return hours ? { ...d, workHours: ['08:00', '17:00'] } : d }
/** Serve the plan with working hours (ADR 0014). */
let hours = false
let socketsOpened = 0, socketsClosed = 0, wakes = 0, reorders = 0, batches = 0, batchSeq = 0, notes = 0,
    saves = 0, reverts = 0, creates = 0
/** Plans this run asked for, by the title it asked under. THE ONLY CALL WITH NO
 *  TOKEN, because it is where a token comes from — and the response is the only
 *  time that token is ever shown, since nothing lists plans. Recorded rather than
 *  merely counted so a check can prove the import made a plan PER entry in the
 *  bundle rather than one for the file. */
const created: string[] = []

/** EVERY COMMAND THE PAGE PUT ON THE WIRE, in order. Counting is not enough for
 *  the cycle refusal: what has to be proved there is that NOTHING was sent, and
 *  "nothing" is only distinguishable from "something else" if you kept the
 *  something. Presence frames ride the same socket and are deliberately left
 *  out — they are not commands and never enter the log. */
const wire: unknown[] = []

/** And every command that came over HTTP instead. A swap is the one operation
 *  that will NOT go down the socket — it replaces both channels' value lists and
 *  repoints every task in one atomic batch — so "what did the page send" has two
 *  answers and conflating them would let either hide the other being empty. */
const posted: unknown[] = []

const json = (o: unknown) => new Response(JSON.stringify(o),
  { headers: { 'content-type': 'application/json' } })

const server = serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/api/connect') {
      // A TOKEN THAT REACHES NOTHING. The room refuses the socket and the plan
      // route 404s — which is what a wrong, revoked or mistyped token looks like
      // from the page, and is deliberately indistinguishable from a plan that was
      // never there (ADR 0002). What must NOT happen is the fixture being shown
      // in its place: a plausible wrong chart in a meeting is the worst failure
      // this tool has.
      if (gone) return new Response('no such plan', { status: 404 })
      if (srv.upgrade(req)) return undefined as unknown as Response
      return new Response('expected websocket', { status: 400 })
    }
    // A BATCH IS HTTP, NOT THE SOCKET, AND IT MUST COME BACK DOWN THE SOCKET.
    //
    // Single commands ride the websocket; anything all-or-nothing — deleting a
    // channel value moves every task off it first, in one commit — goes to `POST
    // /api/commands`. The stub answered 404, so every batch silently did nothing.
    //
    // Accepting it is not enough either, and the reason is written at the call
    // site: an HTTP command carries no session ref, so the server broadcasts the
    // batch to EVERYONE INCLUDING the sender, and the page deliberately does NOT
    // apply it optimistically — applying it locally as well would apply it twice.
    // So a stub that returns `{ok:true}` and broadcasts nothing leaves the chart
    // exactly as it was, which reads as "the delete did not work".
    if (url.pathname === '/api/commands') {
      batches++;
      const body = await req.json().catch(() => ({})) as { cmd?: unknown; cmds?: unknown[] }
      const list = body.cmds ?? (body.cmd ? [body.cmd] : [])
      for (const cmd of list) { posted.push(cmd); srv.publish('room', JSON.stringify({ type: 'cmd', cmd, seq: ++batchSeq })) }
      return json({ ok: true, seq: batchSeq })
    }
    if (url.pathname === '/__mode') {
      const p = url.searchParams
      // `has`, not `get`: every existing caller passes only `big`, and reading an
      // absent flag as "off" would silently switch the others back.
      if (p.has('big')) serving = p.get('big') === '1' ? 'big' : 'small'
      if (p.has('waking')) waking = p.get('waking') === '1'
      if (p.has('cycle')) cycle = p.get('cycle') === '1'
      if (p.has('gone')) gone = p.get('gone') === '1'
      if (p.has('sortme')) sortme = p.get('sortme') === '1'
      if (p.has('stale')) stale = p.get('stale') === '1'
      if (p.has('noworker')) noworker = p.get('noworker') === '1'
      if (p.has('slowsearch')) slowsearch = p.get('slowsearch') === '1'
      if (p.has('hours')) hours = p.get('hours') === '1'
      return json({ serving, waking, cycle, gone, sortme, stale, noworker, slowsearch })
    }
    // A SECOND PERSON IN THE ROOM, WITHOUT A SECOND BROWSER.
    //
    // Presence is never sequenced and never persisted (see PRESENCE in
    // `sync-server/src/room.ts`), so everything the page ever learns about
    // somebody else arrives as a `presence` frame on its OWN socket. Publishing
    // one is therefore the whole of being a peer, and the stub already publishes
    // to this room for a batch — same mechanism, one more caller.
    //
    // A real second WebSocket would prove something about the fan-out, which is
    // the room's job and already covered in `sync-server/test/`. What has never
    // been exercised is the PAGE's half: `ui/Presence.tsx` had no checks at all,
    // and being alone in a room looks exactly like multiplayer being broken.
    //
    // `left=1` sends the departure frame instead; no `day` means present but not
    // pointing, and no `name`/`color` means a peer who sent neither, which the
    // page has to have an answer for.
    if (url.pathname === '/__peer') {
      const p = url.searchParams
      const sessionId = p.get('id') || 'peer1'
      srv.publish('room', JSON.stringify(p.get('left')
        ? { type: 'left', sessionId }
        : { type: 'presence', presence: {
            sessionId, name: p.get('name'), color: p.get('color'),
            cursor: p.has('day') ? { day: Number(p.get('day')), laneRow: Number(p.get('row')) } : null } }))
      return json({ ok: true })
    }
    // THE ONE CALL WITH NO TOKEN. `POST /api/plan/new` is where a token comes
    // from, so it cannot require one — and its response is the only time that
    // token is ever visible, because nothing lists plans. The id is the SERVER's
    // to choose; a caller that picks one has misunderstood ADR 0002.
    //
    // Nothing is stored: this stub has no bucket and a check that created real
    // plans would litter a real one. What matters to the page is the shape.
    if (url.pathname === '/api/plan/new') {
      creates++
      const body = await req.json().catch(() => ({})) as { title?: string }
      created.push(String(body.title ?? ''))
      return json({ id: 'made' + creates, shareToken: 'tok' + String(creates).padStart(19, '0') })
    }
    if (url.pathname === '/api/plan') {
      if (gone) return new Response('no such plan', { status: 404 })
      return json({ id: 'harness', seq: 0, viewers: 1, doc: livePlan() })
    }
    // `last=1` is the newest version alone, and `meta=1` drops the documents —
    // the stub honours both because the page asks for the cheap combination on
    // every load, and a stub that answered the whole archive to that would hide
    // the page asking for the whole archive.
    if (url.pathname === '/api/history') {
      const q = url.searchParams
      const versions = q.get('last') ? VERSIONS.slice(-1) : VERSIONS
      return json({ versions: q.get('meta') ? versions.map(({ doc, ...meta }) => meta) : versions })
    }
    // ONE VERSION, BY NUMBER — what Compare asks for. It used to search the whole
    // archive it had already downloaded.
    if (url.pathname === '/api/version') {
      const v = VERSIONS.find(x => x.n === Number(url.searchParams.get('n')))
      return v ? json(v) : new Response(JSON.stringify({ error: 'no such version' }), { status: 404 })
    }
    // Only the NOTE on an archived version is mutable; the snapshot is frozen.
    if (url.pathname === '/api/histnote') { notes++; return json({ ok: true }) }
    // SAVING AND CHANGING ARE DIFFERENT ACTS: commands change the live draft for
    // everyone immediately, and `save` is what turns that draft into an archived
    // version. The stub answers with the shape the page reads back — the new
    // version's number and when — so "Save" can be tested at all.
    if (url.pathname === '/api/save') {
      saves++
      return json({ n: VERSIONS.length + saves, at: new Date().toISOString(),
                    note: 'stub save', by: 'harness' })
    }
    // REVERT IS THE ONE HISTORY OPERATION THAT CHANGES THE ROOM. It discards the
    // live draft for EVERYONE and announces it, which is why the page expects the
    // document back rather than an acknowledgement.
    if (url.pathname === '/api/revert') {
      reverts++
      // AND IT HAS TO COME BACK DOWN THE SOCKET, for the same reason a batch
      // does. `#revert` deliberately does no render and no adopt of its own —
      // the server broadcasts `reverted` to everyone INCLUDING the reverter, and
      // `onFrame` is the one place it lands, because doing it twice is how a
      // document and a room start to disagree. A stub that answered `{ok:true}`
      // and broadcast nothing left the chart exactly as it was, which is
      // indistinguishable from the revert not having happened.
      const n = (await req.json().catch(() => ({})) as { n?: number }).n ?? VERSIONS.length
      srv.publish('room', JSON.stringify({ type: 'reverted', seq: ++batchSeq, epoch: 'e1',
        doc: livePlan(), from: n, note: 'save number ' + n, by: 'Ada' }))
      return json({ ok: true, doc: livePlan(), n })
    }
    if (url.pathname === '/__probe') return json({ socketsOpened, socketsClosed, wakes, reorders, batches, notes, saves, reverts, wire, posted, creates, created })
    // Counted, not just answered: playback must not fire these. On a real plan
    // each one occupies the server for ~90s.
    if (url.pathname === '/reorder' || url.pathname.startsWith('/api/reorder')) {
      reorders++
      // THE SHAPE THE PAGE READS, not the shape the old stub returned. `{moves,
      // lanes:[]}` gave `nudge.suggestions === undefined` and `nudge.lanes.changed`
      // on an array, so the chip never appeared and the expensive path was never
      // actually observed by anything.
      // LANE ORDER IS OFFERED, NOT SUPPLIED. `changed: true` is what puts the
      // "Sort teams" button on the panel; the order it names is never used,
      // because `applyLaneOrder` recomputes locally against the real document —
      // which is the honest thing for it to do and the reason this stub can hand
      // back an empty list and still be testing something.
      return json({ base: { finish: 0, ms: {} }, skipped: [],
        lanes: { order: [], backward: 3, total: 12, was: 7, changed: true },
        suggestions: [{ lane: 'A', id: 'b6', label: 'Big 6', from: 1, to: 0,
                        after: null, gain: 3, gains: { finish: 3 }, worsens: false }] })
    }
    // THE PAGE WAKES THE SERVICE BEFORE IT TALKS TO IT, and the stub has to
    // answer or the console fills with 404s that look like a bug in the page.
    // Worth stating plainly because it is the thing an agent driving this tool
    // with curl gets wrong: /api/* NEVER wakes anything (see ../AGENTS.md).
    if (url.pathname === '/wake') {
      wakes++
      return json(waking ? { status: 'starting', desired: 1, running: 0 }
                         : { status: 'running', desired: 1, running: 1 })
    }
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
    // DIST FIRST, web/ SECOND, and the order is the point. The bundle and the
    // rewritten index.html live in dist/; the shared files do NOT, because they
    // ship from web/ as symlinks into shared/ so that exactly one copy exists
    // (assert-shared-parity.sh refuses a second). That is the same two-source
    // layout the bucket has after a deploy, so the page under test resolves
    // `/schedule.js` here exactly the way it will in production.
    //
    // A STALE web/app.js WOULD BE SERVED IN PREFERENCE TO NOTHING if the fallback
    // came first, which is why it does not: dist/index.html names a hashed asset
    // and cannot accidentally pick up the pre-bundler page.
    const p = url.pathname === '/' ? '/index.html' : url.pathname
    // A DEVICE THAT CANNOT RUN THE SEARCH. Withholding the worker script is the
    // cheapest honest way to produce that: `new Worker()` fires `error`, every
    // request waiting on it is rejected, and the page has to fall back to the
    // server rather than leave the panel spinning.
    if (noworker && p.startsWith('/assets/reorder-worker')) {
      return new Response('not found', { status: 404 })
    }
    // A SCHEDULER THE BUNDLE DID NOT SHIP WITH, which is a live production state
    // rather than a hypothetical. `/schedule.js` is UNHASHED at the bucket root
    // under `max-age=300`, while `index.html` is `no-cache` and `/assets/*` is
    // immutable — so for five minutes after a deploy a browser can revalidate the
    // entrypoint, pull the new hashed bundle, and satisfy its `import "/schedule.js"`
    // from a cache holding the old one. New page, old scheduler.
    //
    // Nothing else in the stack can see that. `assert-shared-parity.sh` proves the
    // bucket's copy matches the image's; `smoke.sh` proves the bundle still IMPORTS
    // the file rather than inlining it. Neither knows which bytes a given browser
    // actually got. `selftest()` does, because it runs the reference plans through
    // whatever `/schedule.js` this page loaded.
    //
    // The edit is ONE TOKEN, in the dependency gate: `if (e > dep)` becomes
    // `if (e < dep)`, so `dep` never rises above its initial 0 and every task is
    // scheduled as though it waited for nothing. The file still parses, still
    // exports everything, and produces a schedule that violates the plan's own
    // dependencies — which is exactly what the audit is there to notice, and
    // exactly the quiet way a stale copy is wrong.
    // A DEVICE WHERE THIS TAKES A WHILE, which is the one condition the page's
    // adaptive behaviour turns on and the one a test cannot otherwise produce.
    //
    // CPU THROTTLING DOES NOT REACH THE WORKER — measured: at Chrome's 4x rate
    // the search still finished in 1142ms, faster than the 1.8s it takes on the
    // main thread unthrottled, because it has a thread to itself. So "slow
    // device" has to be made out of the only thing the stub controls, which is
    // the bytes of the scheduler. A busy-wait rather than a sleep, because what
    // the page measures is elapsed time and what a slow phone spends is CPU.
    if (slowsearch && p === '/schedule.js') {
      const src = await Bun.file(join(WEB, 'schedule.js')).text()
      const slow = src.replace('export function suggestReorders(raw, opts = {}) {',
        'export function suggestReorders(raw, opts = {}) {\n'
        + '  { const t = Date.now(); while (Date.now() - t < 3500) ; }')
      if (slow === src) return new Response('slowsearch patch did not apply', { status: 500 })
      return new Response(slow, { headers: { 'content-type': 'text/javascript' } })
    }
    if (stale && p === '/schedule.js') {
      const src = await Bun.file(join(WEB, 'schedule.js')).text()
      const bent = src.replace('if (e > dep)\n                    dep = e;',
                               'if (e < dep)\n                    dep = e;')
      if (bent === src) return new Response('stale-mode patch did not apply', { status: 500 })
      return new Response(bent, { headers: { 'content-type': 'text/javascript' } })
    }
    for (const root of [DIST, WEB]) {
      const f = Bun.file(join(root, p))
      if (await f.exists()) return new Response(f)
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      socketsOpened++
      // So a batch posted over HTTP can be broadcast back to this tab.
      ws.subscribe('room')
      ws.send(JSON.stringify({
        type: 'welcome', sessionId: 's' + socketsOpened, epoch: 'e1', seq: 0,
        id: 'harness', doc: livePlan(), presence: [],
      }))
    },
    message(_ws, m) {
      const f = JSON.parse(String(m)) as { type?: string; cmd?: unknown }
      if (f.type === 'cmd') wire.push(f.cmd)
    },
    close() { socketsClosed++ },
  },
})
console.log(`harness on http://127.0.0.1:${PORT}/#harnesstoken0000000000`)

if (!process.argv.includes('--check')) {
  console.log('serving — ctrl-c to stop')
} else {
  const puppeteer = (await import('puppeteer-core')).default
  // Chrome, wherever this is running. CI is Linux and has no .app bundle; the
  // env var wins so a runner can point at whatever it installed.
  const CANDIDATES = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[]
  const CHROME = CANDIDATES.find(p => existsSync(p))
  if (!CHROME) {
    console.error('no Chrome found. Tried:\n  ' + CANDIDATES.join('\n  '))
    server.stop(true); process.exit(1)
  }
  const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME })
  const page = await b.newPage()
  // HOW TO REPRODUCE A CI-ONLY FAILURE ON A LAPTOP. This suite drives a page whose
  // updates arrive over a socket and are committed by React asynchronously, so its
  // worst failures are races that a developer machine is simply too fast to lose —
  // they show up only on a shared runner, a handful of runs out of ten, and read as
  // "flaky CI" rather than as the missing wait they actually are.
  //
  // `HARNESS_CPU_THROTTLE=4 npm run test:playback` throttles the BROWSER (not the
  // machine) through CDP and loses those races on demand. The grouping-list check
  // below failed four CI runs across a week, passed every local run, and failed on
  // the first throttled one. Unset, this costs nothing.
  if (process.env.HARNESS_CPU_THROTTLE) {
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.HARNESS_CPU_THROTTLE) })
  }
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
  // THE URL, BECAUSE THE CONSOLE MESSAGE DOES NOT CARRY IT. Chrome logs a failed
  // subresource as "Failed to load resource: the server responded with a status of
  // 404 (Not Found)" and names nothing — so a real regression and a stray favicon
  // are the same string, and the only way to tell them apart is to go looking by
  // hand. This has cost time on the live site once already.
  // WITHHOLDING A FILE ON PURPOSE IS NOT A PAGE ERROR. One check makes the worker
  // script 404 to prove the page falls back to the server; without this it also
  // fails "no page errors" two hundred lines later, which is a true statement
  // about a thing the test did.
  let expect404: RegExp | null = null
  page.on('response', r => {
    if (r.status() >= 400 && !(expect404 && expect404.test(r.url()))) {
      errs.push(`HTTP ${r.status()} ${r.url()}`)
    }
  })
  await page.setViewport({ width: 1400, height: 900 })
  await page.goto(`http://127.0.0.1:${PORT}/#harnesstoken0000000000`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#chart', { timeout: 15000 })
  // THE PLAN HAS TO ARRIVE, and that is a wait for a thing rather than for the
  // page to go quiet: the document comes over the socket, and a page that has not
  // been sent one yet is perfectly still. Written out rather than calling
  // `until()` because this runs BEFORE the helpers are declared — a `const` used
  // above its declaration throws, which this file has now been bitten by five
  // times and once more just now.
  await page.waitForFunction(`document.querySelectorAll('#grid .row').length > 0`,
    { timeout: 15000, polling: 25 })

  // DOM ONLY. The page exposes nothing on `window`, and this drives it entirely
  // through clicks and selectors — a test hook added just for this would be a
  // second way in that nothing else uses.
  const q = (fn: string) => page.evaluate(fn) as Promise<never>
  const rows = () => q(`document.querySelectorAll('#grid .row').length`) as unknown as Promise<number>
  const msbar = () => q(`document.getElementById('msbar').textContent.trim()`) as unknown as Promise<string>
  const probe = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__probe`)).json())
  /** Counters off the stub. WITH THE OTHER HELPERS — both of these were declared
   *  beside their first use, two hundred lines below a later caller, and threw
   *  "cannot access before initialization". That is now the SEVENTH time this file
   *  has been bitten by a `const` used above its declaration, so the rule is not
   *  "remember": every helper goes here. */
  const reverts = async () => ((await probe()) as { reverts: number }).reverts
  // NOT `reorders`: that name is the STUB's counter, module scope and therefore in
  // scope here too — reading it gives a number that never changes rather than the
  // number the server has actually been asked for.
  const reorderCalls = async () => ((await probe()) as { reorders: number }).reorders

  /** The on-screen box of an element, or null. DECLARED WITH THE OTHER HELPERS
   *  rather than beside its first use: it was a `const` two hundred lines further
   *  down, and calling it from earlier threw `Cannot access 'boxOf' before
   *  initialization` — the same temporal-dead-zone shape as the `refuse()` bug
   *  recorded in `emit`, which is worth not repeating in the file that exists to
   *  catch things like it. */
  const boxOf = async (sel: string) => await page.evaluate(`(() => {
    const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`) as unknown as { x: number; y: number; w: number; h: number } | null

  /** A row by its task id. Exact, unlike matching label text — "Task 7" is also a
   *  prefix of "Task 70". */
  const rowOf2 = (id: string) => `document.querySelector('#grid .row[data-task="${id}"]')`
  /** `#dur` CARRIES ITS UNIT — "2h", "1h30m", "45m" (hours only since ADR 0014)
   *  — so `+value` is NaN and every comparison against it is false without ever
   *  saying why (the failure detail read "NaNd -> NaNd"). Parsed to days, the
   *  scheduler's unit, matching `fmtDur` in app.ts. */
  const durDays = (v: string | null) => {
    const m = v == null ? null : v.match(/^(?:([0-9.]+)h)?(?:([0-9.]+)m)?$/)
    if (!m || (m[1] == null && m[2] == null)) return null
    return (m[1] ? +m[1] / 24 : 0) + (m[2] ? +m[2] / 1440 : 0)
  }
  /** SELECT A TASK AND OPEN ITS PANEL, because those stopped being the same
   *  gesture. A third inspector size landed after this file was written, and the
   *  first click now leaves `#insp` FOLDED where it used to leave it open. Every
   *  check below that reaches into the panel's BODY was therefore driving
   *  controls inside a collapsed box: `#urlbtn` reports a 0x0 rect when folded,
   *  so the link popover "opened" at 0,0 with no size and never took focus, and
   *  the actuals fields were not in the DOM to be typed into at all.
   *
   *  THE PAGE IS NOT BROKEN — checked by hand at both sizes: expanded, the
   *  popover lands above its button, inside the window, with the caret in `#url`.
   *  This file was asking for the panel and being handed the tab.
   *
   *  It goes through `#inspfold`, the panel's own size control, rather than
   *  clicking the bar a second time — a second click cycles the SAME counter, so
   *  a later re-select would walk it on to `full` instead of landing anywhere
   *  predictable. */
  const selectTask = async (id: string) => {
    await page.evaluate(`${rowOf2(id)}.querySelector('.bar').click()`)
    await settle()
    await page.evaluate(`(() => { const el = document.getElementById('insp');
      if (el && el.classList.contains('folded')) document.getElementById('inspfold').click(); })()`)
    await settle()
  }
  /** The flash line. It clears itself after 3.5s, so a check that reads it should
   *  blank it first or it will read the previous message. */
  const msg = () => q(`document.getElementById('msg').textContent`) as unknown as Promise<string>

  /** WAIT FOR THE PAGE TO STOP CHANGING, NOT FOR A NUMBER OF MILLISECONDS.
   *
   *  This suite used to hold 109 hand-picked `setTimeout`s adding up to 48 of its
   *  60 seconds, at 27% CPU — it spent four fifths of its life asleep, and every
   *  one of those numbers was a guess that had to be big enough for the slowest
   *  machine anyone would run it on. A guess that is too small is worse: it does
   *  not fail, it asserts against a half-drawn page and fails somewhere else.
   *
   *  So: observe the DOM and return once it has been quiet for `quiet` ms. A
   *  render finishes in single digits, so the usual cost is one quiet window
   *  rather than a fifth of a second.
   *
   *  IT IS NOT A UNIVERSAL REPLACEMENT, and the limit is worth stating rather
   *  than discovering. A fetch that has not come back yet has a perfectly quiet
   *  DOM, and so does a page mid-way through a playback frame's timer — for those,
   *  `until()` below waits for the thing itself. `cap` is the ceiling, and hitting
   *  it means this was the wrong tool at that call site, not that the page is slow.
   *
   *  Built inline rather than installed on `window`: the run reloads the page for
   *  the fingerprint, and an installed helper would quietly vanish there. */
  const settleRaw = (quiet: number, cap: number) => page.evaluate(`new Promise(res => {
    let t, done = false; const t0 = performance.now();
    const fin = () => { if (done) return; done = true; obs.disconnect();
      clearTimeout(t); clearTimeout(hard); res(Math.round(performance.now() - t0)); };
    const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, ${quiet}); });
    obs.observe(document.documentElement,
      { subtree: true, childList: true, attributes: true, characterData: true });
    t = setTimeout(fin, ${quiet});
    const hard = setTimeout(fin, ${cap});
  })`) as unknown as Promise<number>
  const settle = async (quiet = 40, cap = 1500) => {
    const ms = await settleRaw(quiet, cap)
    // HITTING THE CEILING MEANS THIS WAS THE WRONG WAIT, not that the page is
    // slow — something is still moving, or the thing being waited for has not
    // started. Said out loud so it is a line in the log rather than a mystery
    // half-second nobody attributes to anything.
    if (ms >= cap) console.log(`  --   settle hit its ${cap}ms ceiling; that call site wants until()`)
    return ms
  }

  /** Wait for a CONDITION. Where `settle` asks "has the page stopped moving",
   *  this asks "is the thing I am about to assert true yet" — which is the honest
   *  wait for anything that crosses the network, rejoins the room, or is driven by
   *  a timer of its own. A timeout is reported as a failing check naming what it
   *  was waiting for, rather than thrown: an aborted run points at nothing. */
  const soon = async (expr: string, ms = 5000) => {
    try { await page.waitForFunction(`(() => ${expr})()`, { timeout: ms, polling: 25 }); return true }
    catch { return false }
  }
  const until = async (expr: string, what: string, ms = 5000) =>
    (await soon(expr, ms)) || (check(`waiting for ${what}`, false, `still false after ${ms}ms`), false)
  /** Make somebody else appear in this room — see `/__peer` in the stub. */
  const peer = (qs: string) => fetch(`http://127.0.0.1:${PORT}/__peer?${qs}`)
  /** Switch the stub between the plans and the failures it can serve. WITH THE
   *  OTHER HELPERS, not beside its first use: it was declared in the last section
   *  of the run and called from one two hundred lines above, which throws
   *  "cannot access before initialization". That is the sixth time this file has
   *  been bitten by exactly that. */
  const mode = (qs: string) => fetch(`http://127.0.0.1:${PORT}/__mode?${qs}`)
  /** The roster strip, and the pointers on the chart. Read together because
   *  they are two halves of one answer and a strip that disagrees with the
   *  cursors is worse than either alone. */
  const chips = async () => JSON.parse(await q(`JSON.stringify(
    [...document.querySelectorAll('#who .whochip')].map(c => ({
      name: c.querySelector('b').textContent, mine: c.classList.contains('me') })))`) as unknown as string)
  const pointers = async () => JSON.parse(await q(`JSON.stringify(
    [...document.querySelectorAll('#cursors .pcur')].map(c => ({
      name: c.querySelector('b').textContent,
      color: c.querySelector('b').style.background,
      left: parseFloat(c.style.left), top: parseFloat(c.style.top) })))`) as unknown as string)

  /** Set a CONTROLLED input's value the way a user would, not the way a script
   *  wants to. React puts a value tracker on every input it controls and uses it
   *  to decide whether an `input` event is a real change — so `el.value = x;
   *  dispatchEvent(new Event('input'))` is seen by React as no change at all, and
   *  the handler never runs. Going through the prototype's own setter updates the
   *  node without touching the tracker, which is what makes the next event look
   *  real. Silent before the port, because nothing was controlled. */
  const setNative = (sel: string, value: string, proto = 'HTMLInputElement') =>
    page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)

  // A NATIVE DIALOG BLOCKS EVERY SUBSEQUENT COMMAND until something answers it,
  // and puppeteer will not answer one by itself — the run simply hangs until the
  // 120s timeout kills it, with no failing check to point at. `delChannelValue`
  // asks `confirm("Remove …?")`, so removing a channel value is untestable
  // without this. Accepting is what a person clicking × means; the counter lets a
  // check assert that the question was asked at all.
  let dialogs = 0
  page.on('dialog', async d => { dialogs++; await d.accept() })

  /** `AUTO_MS` in `app.ts`: under this the panel keeps itself current, over it the
   *  panel goes back to marking the answer stale. Named here so the check that
   *  straddles it says which number it is straddling. */
  const AUTO_MS_UNDER_TEST = 3000
  const results: [string, boolean, string][] = []
  const check = (name: string, ok: boolean, detail = '') => {
    results.push([name, ok, detail]); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  }

  /** DRAW THE FINISHED WORK TOO. `showDone` is view state and resets on every
   *  load, so this has to run after each one — see the long note at its first
   *  use below. Tolerant on purpose: some reloads land on the landing page or on
   *  a plan that failed to open, where there is no legend to tick. */
  const showAllRows = async () => {
    await page.evaluate(`(() => { const b = document.getElementById('showdone');
      if (b && !b.checked) b.click(); })()`)
    await settle()
  }
  /** `page.reload` PLUS THAT TICK, everywhere. Twenty-two reloads in this file
   *  and every one of them was silently dropping the finished rows back out of
   *  the chart, which is why fixing the first row count only moved the failure
   *  further down. */
  const reloadPage = async (waitUntil: 'networkidle2' | 'domcontentloaded' = 'networkidle2') => {
    await page.reload({ waitUntil })
    await showAllRows()
  }

  // EVERY TASK IN THE FIXTURE HAS TO BE ON THE CHART, or this whole file is
  // asking questions about a filtered view and calling the answers facts.
  //
  // `showDone` defaults to OFF (see the note over it in app.ts): finished and
  // dropped work is not drawn unless you ask for it. That shipped after this
  // harness was written, and it is what broke it — every row count below was one
  // short, and the checks that FINISH a task then look for its row were asserting
  // against a row the chart had just removed on purpose. Neither is a bug in the
  // page; both are this file reading a view preference as a document.
  //
  // Ticked once, here, rather than repaired count by count: the numbers below are
  // meant to say "this many tasks are in the document", and that is only true of
  // a chart drawing all of them.
  await showAllRows()

  // The fingerprint of the LIVE plan, taken through the chart itself.
  const liveRows = await rows()
  const liveMs = await msbar()
  const beforeSockets = await probe()
  check('live plan is on the chart to begin with', liveRows === 11, `${liveRows} rows`)

  check('transport bar is hidden before playback',
    (await q(`getComputedStyle(document.getElementById('playbar')).display === 'none'`) as unknown as boolean) === true)

  await page.click('#histbtn')
  // The rows come back over the network, so a quiet DOM does not mean they have
  // arrived: a settle here once ended before them and the first read hit null.
  await until(`document.querySelectorAll('#hist-list .hrow').length === 6`, 'the History rows')
  // ---- HISTORY --------------------------------------------------------------
  // Newest first, and every row says what changed SINCE THE SAVE BEFORE IT — which
  // means the deltas are computed in chronological order and the list reversed
  // afterwards, not the other way round. The oldest row is the one that says so.
  check('the newest save is at the top and the oldest reads "first version"',
    (await q(`document.querySelector('#hist-list .hrow b').textContent`) as unknown as string) === '#6'
      && (await q(`[...document.querySelectorAll('#hist-list .hrow .hdelta')].pop().textContent`) as unknown as string)
           .includes('first version'))
  check('a later finish is marked as worse than an earlier one',
    (await q(`document.querySelectorAll('#hist-list .hdelta .up, #hist-list .hdelta .dn').length`) as unknown as number) > 0,
    await q(`[...document.querySelectorAll('#hist-list .hdelta')].slice(0,2).map(e => e.textContent).join(' | ')`) as unknown as string)

  // A NOTE IS A SENTENCE SOMEBODY IS COMPOSING, so it commits on blur rather than
  // per keystroke — every character would otherwise be a round trip.
  const notesBefore = (await probe()).notes
  await page.focus('#hist-list .hnote')
  await page.keyboard.type('edited')
  check('typing a note sends nothing yet', (await probe()).notes === notesBefore)
  await page.evaluate(`document.querySelector('#hist-list .hnote').blur()`)
  await settle()
  check('blurring it saves the note once', (await probe()).notes === notesBefore + 1,
    `${notesBefore} -> ${(await probe()).notes}`)

  await page.evaluate(`document.querySelector('#hist-list .hcmp').click()`)
  await settle()
  check('Compare marks the row it is comparing against',
    (await q(`document.querySelector('#hist-list .hcmp').textContent`) as unknown as string) === 'Comparing'
      && (await q(`document.querySelectorAll('#hist-list .hcmp').length`) as unknown as number) === 6)
  await page.evaluate(`document.querySelector('#hist-list .hcmp').click()`)
  await settle()
  check('and clicking it again turns the lens off',
    (await q(`document.querySelector('#hist-list .hcmp').textContent`) as unknown as string) === 'Compare')

  check('History lists the harness saves',
    (await q(`document.querySelectorAll('#hist-list .hrow').length`) as unknown as number) === 6)
  check('every row offers Play',
    (await q(`document.querySelectorAll('#hist-list .hplay').length`) as unknown as number) === 6)
  // A REAL ASSERTION, not a shape check: adding Play made a 9th child of an
  // 8-column grid, which silently wrapped Fork onto a second line in every row.
  // Nothing threw and every count still matched — only the pixels were wrong.
  check('history rows stay on one line',
    (await q(`(() => {
      const r = document.querySelector('#hist-list .hrow');
      // Not equality: align-items:center gives children of different heights
      // slightly different tops (~7px observed). A WRAP moves one a full row
      // down, which is 30px+, so the spread is the signal.
      const tops = [...r.children].map(c => c.offsetTop);
      return Math.max(...tops) - Math.min(...tops) < 20;
    })()`) as unknown as boolean) === true,
    String(await q(`(() => {
      const r = document.querySelector('#hist-list .hrow');
      const t = [...r.children].map(c => c.offsetTop);
      return 'spread ' + (Math.max(...t) - Math.min(...t)) + 'px, height ' + Math.round(r.getBoundingClientRect().height);
    })()`)))

  await page.click('#hist-play-all')
  await settle()

  check('transport bar is VISIBLE (not merely un-hidden)',
    (await q(`getComputedStyle(document.getElementById('playbar')).display !== 'none'
              && document.getElementById('playbar').getBoundingClientRect().height > 0`) as unknown as boolean) === true)
  check('history panel closed itself',
    (await q(`document.getElementById('hist').hidden`) as unknown as boolean) === true)
  check('body marked as playing',
    (await q(`document.body.classList.contains('playing')`) as unknown as boolean) === true)
  check('chart shows save #1, not the live plan', (await rows()) === 2,
    `${await rows()} rows, live had ${liveRows}`)
  check('socket was closed on entry',
    (await probe()).socketsClosed === beforeSockets.socketsClosed + 1)
  check('every editing control is disabled',
    (await q(`['#save','#revert','#add','#renamebtn'].every(s=>document.querySelector(s).disabled)`) as unknown as boolean) === true)

  await page.click('#pb-next'); await settle()
  await page.click('#pb-next'); await settle()
  check('stepping forward redraws a different document', (await rows()) === 4, `${await rows()} rows`)
  check('counter tracks position',
    ((await q(`document.getElementById('pb-count').textContent`) as unknown as string) || '').includes('3/6'),
    String(await q(`document.getElementById('pb-count').textContent`)))

  // ---- the arc ------------------------------------------------------------
  check('the arc drew a line and a fill',
    (await q(`document.querySelectorAll('#pb-arc .arc-line, #pb-arc .arc-fill').length`) as unknown as number) === 2)
  check('the arc drew a rule per milestone',
    (await q(`document.querySelectorAll('#pb-arc .arc-ms').length`) as unknown as number) === 1,
    'harness plan has one milestone')
  check('milestone rules carry a title',
    ((await q(`document.querySelector('#pb-arc .arc-ms title')?.textContent || ''`) as unknown as string)).includes('Ship'))
  const headAt = () => q(`(()=>{const c=document.querySelector('#pb-arc .arc-head');
    return c.getAttribute('cx')+','+c.getAttribute('cy')+','+(c.getAttribute('opacity')||'1')})()`) as unknown as Promise<string>
  const headBefore = await headAt()
  await page.click('#pb-next'); await settle()
  check('the playhead moves with the version', (await headAt()) !== headBefore,
    `${headBefore} -> ${await headAt()}`)
  // The forecast in the harness gets LATER every save, so the head must climb —
  // this is the "up is later" contract, and it would pass either way if the y
  // axis were flipped without it.
  check('a later forecast sits HIGHER',
    Number((await headAt()).split(',')[1]) < Number(headBefore.split(',')[1]),
    `y ${headBefore.split(',')[1]} -> ${(await headAt()).split(',')[1]}`)
  const beforeClick = await q(`document.getElementById('pb-count').textContent`) as unknown as string
  await page.evaluate(`(()=>{const a=document.getElementById('pb-arc'),r=a.getBoundingClientRect();
    a.dispatchEvent(new MouseEvent('click',{clientX:r.left+r.width*0.06,clientY:r.top+10,bubbles:true}))})()`)
  await settle()
  check('clicking the arc jumps to that save',
    (await q(`document.getElementById('pb-count').textContent`) as unknown as string) !== beforeClick,
    `${beforeClick} -> ${await q(`document.getElementById('pb-count').textContent`)}`)

  // EXPLICIT POSITION, not "wherever the last click left us". These two assert
  // facts about save #4 specifically, and they broke the moment a test above
  // them started jumping around.
  const seek = async (i: number) => {
    await setNative('#pb-scrub', String(i))
    await settle()
  }
  await seek(3)
  check('seek lands on save #4',
    ((await q(`document.getElementById('pb-count').textContent`) as unknown as string) || '').includes('#4'))
  check('an empty note says so',
    ((await q(`document.getElementById('pb-note').textContent`) as unknown as string) || '').includes('without a note'))

  // THE PROPERTY THAT MATTERS, tested as behaviour rather than as a call: with
  // an archived document on the chart, do the things a user does — select a bar,
  // press the reorder and duplicate shortcuts, click the frozen buttons — and
  // then assert the LIVE plan came back exactly as it left. This asserts the
  // outcome (playback cannot change the plan) rather than the mechanism, so it
  // keeps holding if the guard ever moves.
  await page.evaluate(`(document.querySelector('#grid .row .bar') || document.querySelector('#grid .bar'))?.click()`)
  await settle()
  for (const k of ['ArrowUp', 'ArrowDown']) {
    await page.keyboard.down('Alt'); await page.keyboard.press(k); await page.keyboard.up('Alt')
  }
  await page.keyboard.down('Meta'); await page.keyboard.press('d'); await page.keyboard.up('Meta')
  for (const sel of ['#add', '#save', '#revert', '#link']) {
    try { await page.click(sel, { delay: 10 }) } catch {}
  }
  await settle()
  check('none of that escaped playback', (await rows()) === 5, `${await rows()} rows on save #4`)

  // THE BACKSTOP ITSELF, reached the way a real user would reach it. Everything
  // above only ever clicked controls PLAY_FROZEN had disabled, and a disabled
  // control never calls `emit` — so the guard inside `emit` was never executed by
  // any test. It was also broken: it called `refuse()` from inside that const's
  // temporal dead zone, so instead of refusing it threw a ReferenceError. tsc
  // found that (TS2448); this makes sure a test would too.
  //
  // The inspector's fields are the honest path: they are NOT on PLAY_FROZEN, they
  // emit on `input`, and they only exist once a bar is selected — which is exactly
  // the "a control somebody adds later" case the guard exists for.
  await page.evaluate(`(document.querySelector('#grid .row .bar') || document.querySelector('#grid .bar'))?.click()`)
  await settle()
  const hasLab = await q(`!!document.getElementById('lab')`) as unknown as boolean
  if (hasLab) {
    const before = await rows()
    await page.evaluate(`(()=>{const el=document.getElementById('lab');
      el.value='HIJACKED'; el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await settle()
    // `#msg`, not `#flash`. This read an id that does not exist, so the detail on
    // a failure here has always been the empty string — harmless, and exactly the
    // kind of thing that stays wrong because it only shows up when something else
    // is already broken.
    const flash = await q(`document.getElementById('msg')?.textContent || ''`) as unknown as string
    check('typing into the inspector during playback is refused, not thrown',
      errs.length === 0 && (await rows()) === before,
      errs.length ? errs.slice(0, 2).join(' | ') : `flash: ${String(flash).slice(0, 60)}`)
  } else {
    check('inspector opened so the emit backstop could be reached', false,
      'no #lab field appeared after selecting a bar — this check did not run')
  }

  const reordersDuring = (await probe()).reorders
  check('playback fired no reorder nudges', reordersDuring === 0,
    `${reordersDuring} reorder request(s) during playback`)

  await page.click('#pb-exit')
  await settle()
  check('transport bar is gone',
    (await q(`getComputedStyle(document.getElementById('playbar')).display === 'none'`) as unknown as boolean) === true)
  check('the live plan came back unchanged', (await rows()) === liveRows && (await msbar()) === liveMs,
    `${await rows()} rows vs ${liveRows}`)
  // ONE new socket, not two: entry closed the original and exit opened its
  // replacement. (This assertion said +2 first, and the run corrected it.)
  check('rejoined the room',
    (await probe()).socketsOpened === beforeSockets.socketsOpened + 1,
    JSON.stringify(await probe()))
  check('the rejoin woke the service first',
    (await probe()).wakes > beforeSockets.wakes, JSON.stringify(await probe()))
  check('editing works again after exit',
    (await q(`document.querySelector('#save').disabled`) as unknown as boolean) === false)

  // A HIDDEN TAB LEAVES THE ROOM after five minutes, and rejoins (woken first) when it is looked at again;
  // a quick switch away and back costs nothing. Hidden is faked, and the five minutes squeezed to nothing.
  const setHidden = (h: boolean) => page.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${h} });
    document.dispatchEvent(new Event('visibilitychange'))`)
  const socks = (p: { socketsOpened: number, socketsClosed: number, wakes: number }) => `opened ${p.socketsOpened}, closed ${p.socketsClosed}, wakes ${p.wakes}`
  const hb = await probe()
  await setHidden(true); await setHidden(false); await settle()
  check('a quick switch away and back keeps the socket', (await probe()).socketsClosed === hb.socketsClosed, socks(await probe()))
  await page.evaluate(`window.__st = window.setTimeout; window.setTimeout = (f, ms, ...a) => window.__st(f, ms >= 300000 ? 0 : ms, ...a)`)
  await setHidden(true)
  await page.evaluate(`window.setTimeout = window.__st`)
  await settle()
  check('a tab hidden for five minutes leaves the room', (await probe()).socketsClosed === hb.socketsClosed + 1, socks(await probe()))
  await setHidden(false)
  for (let i = 0; i < 50 && (await probe()).socketsOpened === hb.socketsOpened; i++) await Bun.sleep(50)
  await settle()
  const ha = await probe()
  check('and rejoins, woken first, when it is looked at', ha.socketsOpened === hb.socketsOpened + 1 && ha.wakes > hb.wakes, socks(ha))
  await page.evaluate(`delete document.hidden`)

  // ---- THE MILESTONE ROW, WHICH REACT DRAWS ---------------------------------
  //
  // `#msbar` is the first container handed to React (web/src/ui/MilestoneBar.tsx).
  // The port DELETED three hand-rolled workarounds, and a deletion needs a test
  // more than an addition does: nothing else in this suite would notice if the
  // behaviour those workarounds bought went with them.
  //
  //   `emit(cmd, keep)` re-focused a named selector after every keystroke, because
  //   `innerHTML =` on the row destroyed the <input> being typed into. The two
  //   checks below are that same behaviour with nothing restoring it.
  check('the milestone row rendered a chip per milestone',
    (await q(`document.querySelectorAll('#msbar [data-ms]').length`) as unknown as number) === 1)
  check("the chip carries the scheduler's verdict",
    /to spare|misses by|exactly on time|no work assigned/
      .test(await q(`document.querySelector('#msbar .ms .vd').textContent`) as unknown as string),
    await q(`document.querySelector('#msbar .ms .vd').textContent`) as unknown as string)

  // THE DISCRIMINATOR, and the reason this is not just a focus test. A property
  // stamped on the live <input> survives a re-render only if the element itself
  // survived it. Under `innerHTML =` the node is replaced and the mark is gone —
  // which is precisely why the caret needed putting back by hand.
  await page.evaluate(`(document.querySelector('#msbar [data-ms-label]').__survived = 'yes')`)
  await page.evaluate(`(() => { const el = document.querySelector('#msbar [data-ms-label]');
                                el.focus(); el.setSelectionRange(2, 2); })()`)
  await page.keyboard.type('ZZ')
  await settle()
  const typed = await page.evaluate(`(() => {
    const el = document.querySelector('#msbar [data-ms-label]');
    return { value: el.value, caret: el.selectionStart,
             focused: document.activeElement === el, survived: el.__survived === 'yes' };
  })()`) as unknown as { value: string; caret: number; focused: boolean; survived: boolean }
  check('the milestone name input is the SAME element after a render',
    typed.survived, 'a stamped property survived — the row reconciled instead of rebuilding')
  check('typing mid-label keeps the caret where it was, with nothing restoring it',
    typed.value === 'ShZZip' && typed.caret === 4 && typed.focused,
    `value ${JSON.stringify(typed.value)} caret ${typed.caret} focused ${typed.focused}`)
  //   The third workaround: `applyFilter()` toggled `.on` by hand rather than
  //   redraw the row. It calls `milestoneBar()` now, so picking has to still work.
  await page.evaluate(`document.querySelector('#msbar [data-ms]').click()`)
  await settle()
  check('clicking a chip filters to it',
    (await q(`document.querySelector('#msbar [data-ms]').classList.contains('on')`) as unknown as boolean) === true)

  // ---- THE LEGEND, which is a key AND the filter ----------------------------
  //
  // Every channel carries two values now — the fixture has to draw a hatch, a
  // pointed shape and a multi-colour bar for the grid fingerprint to be able to
  // fail — so all five appear. `status` and `ready` are DERIVED, and they are in
  // the list for the other half of the same rule: only the values a plan is
  // actually in are offered, and this plan is in two of each.
  //
  // `view` IS NOT A CHANNEL AT ALL and is last on purpose: isolate / effort /
  // done decide how the chart is DRAWN, not which tasks it draws. They used to
  // sit loose in this bar beside the filter cards, which is what made a
  // Cancelled chip and a `cancelled` switch read as one control twice — and
  // cancelling has since gone entirely.
  //
  // `refined` IS THE ONE EXCEPTION AND IT IS PINNED HERE. Nothing in this plan
  // is refined, so that channel has exactly ONE value and every other rule in
  // this file would hide it. It is drawn anyway, because a plan starts with
  // everything unrefined and hiding the chip would mean you cannot find the
  // unrefined work until you have refined some — which you cannot do without
  // finding it. Its position is deliberate too: after `status`, before `ready`,
  // because `ready` now depends on it.
  check('a group per channel with two or more values, and none for the rest',
    (await q(`(() => {
       const g = [...document.querySelectorAll('#legend .grp')].map(e => e.className.match(/g-(\\w+)/)[1]);
       return JSON.stringify(g);
     })()`) as unknown as string) === '["lanes","colors","borders","fills","shapes","status","refined","ready","view"]',
    await q(`JSON.stringify([...document.querySelectorAll('#legend .grp')].map(e => e.className))`) as unknown as string)
  check('the clear button is showing, because a milestone chip is picked',
    (await q(`document.getElementById('clearfilter').hidden`) as unknown as boolean) === false)

  await page.evaluate(`document.querySelector('#legend .g-lanes .it').click()`)
  await settle()
  check('clicking a legend chip marks it picked',
    (await q(`document.querySelector('#legend .g-lanes .it').classList.contains('on')`) as unknown as boolean) === true)
  check('and dims the rows it does not select',
    (await q(`document.querySelectorAll('#grid .row .bar.dim, #grid .row.dim').length`) as unknown as number) > 0,
    `${await q(`document.querySelectorAll('#grid .row .bar.dim, #grid .row.dim').length`)} dimmed`)

  // I FOR ISOLATE, on the filter that is already up. Three claims in one gesture
  // because they are one feature: the KEY fires, the CHECKBOX follows it (a key
  // that changes the mode behind a control still showing the old state is worse
  // than no key), and the lens actually swaps — dimmed rows become absent ones.
  const dimmed = () => q(`document.querySelectorAll('#grid .row .bar.dim, #grid .row.dim').length`) as unknown as Promise<number>
  const rowCount = () => q(`document.querySelectorAll('#grid .row').length`) as unknown as Promise<number>
  const beforeIso = await rowCount()
  // BLURRED FIRST, AND THAT IS THE APP BEING RIGHT RATHER THAN THE TEST CHEATING.
  // A text field still had focus from an earlier section, and `inField` makes the
  // handler stand down there — typing "i" into the search box must search for
  // "i". So the gesture under test is "press I with focus nowhere special",
  // which is a person's hands after clicking a chip.
  await page.evaluate(`document.activeElement.blur()`)
  await page.keyboard.press('i')
  await settle()
  check('I turns on isolate, and the tick-box says so',
    (await q(`document.getElementById('isolate').checked`) as unknown as boolean) === true
      && (await rowCount()) < beforeIso && (await dimmed()) === 0,
    `${beforeIso} rows dimmed-in -> ${await rowCount()} rows, ${await dimmed()} dimmed`)
  await page.keyboard.press('i')
  await settle()
  check('and I again puts the rows back, greyed rather than gone',
    (await q(`document.getElementById('isolate').checked`) as unknown as boolean) === false
      && (await rowCount()) === beforeIso && (await dimmed()) > 0)

  // THE ORDER CHIP IS THERE EVEN WHEN THE ANSWER IS "NOTHING". It used to render
  // only when it had a move to suggest, so "searched and found nothing" and
  // "never ran" were the same picture — which is how a one-lane plan that the
  // search was silently skipping read as "already optimal". The chip is the only
  // door to the panel, so no chip means no way to find out either.
  // NOT BUSY, not merely present: the chip appears the moment the search starts,
  // reading "checking…", and reading it then failed this check whenever the
  // search took longer than the page did to paint (seen 2026-09-26).
  await until(`!!document.querySelector('.ms.reord:not(.busy)')`, 'the Order chip to finish its search', 15000)
  check('the Order chip reports whatever the search found, including nothing',
    /could move|Order looks fine|Not searched|Teams out of order/
      .test(await q(`document.querySelector('.ms.reord .vd')?.textContent || ''`) as unknown as string),
    await q(`document.querySelector('.ms.reord').textContent`) as unknown as string)

  // Effort is opt-in because it roughly doubles the width of every chip. The count
  // stays on the face either way, and the tooltip has said both all along.
  const chipBefore = await q(`document.querySelector('#legend .g-lanes .it .lgc').textContent`) as unknown as string
  await page.evaluate(`document.getElementById('showeffort').click()`)
  await settle()
  const chipAfter = await q(`document.querySelector('#legend .g-lanes .it .lgc').textContent`) as unknown as string
  check('the effort toggle adds the duration beside the count',
    chipAfter.includes('·') && !chipBefore.includes('·') && chipAfter.startsWith(chipBefore),
    `${chipBefore} -> ${chipAfter}`)
  await page.evaluate(`document.getElementById('showeffort').click()`)
  await settle()

  // "Show everything" has to clear the legend picks, the milestone pick and the
  // text box — one button that leaves half the chart missing is a broken promise.
  await page.evaluate(`document.getElementById('clearfilter').click()`)
  await settle()
  check('show everything clears every lens at once',
    (await q(`document.querySelectorAll('#legend .it.on, #msbar [data-ms].on').length`) as unknown as number) === 0
      && (await q(`document.getElementById('clearfilter').hidden`) as unknown as boolean) === true)

  // ---- THE INSPECTOR, CHARACTERISED BEFORE IT IS PORTED ---------------------
  //
  // These describe what `inspector()` DOES, not how. They were written against
  // the imperative version — one `innerHTML` template plus 30 handler
  // assignments — and are the thing the React port has to keep agreeing with.
  // That ordering is the point: a refactor of the main editing surface with no
  // prior behavioural record is a refactor whose regressions are invisible.
  const pick = (label: string) => page.evaluate(`(() => {
    const row = [...document.querySelectorAll('#grid .row')]
      .find(r => r.querySelector('.rowlabel')?.textContent.includes(${JSON.stringify(label)}));
    if (!row) return 'no row for ' + ${JSON.stringify(label)};
    row.querySelector('.bar').click(); return 'ok';
  })()`)
  const insp = (expr: string) => q(`(() => { const b = document.getElementById('insp'); return ${expr} })()`)

  check('selecting a bar opens the inspector on that task',
    (await pick('Task 2')) === 'ok'
      && (await insp(`b.hidden === false && b.querySelector('#lab').value`) as unknown as string) === 'Task 2')
  check('the inspector names what the task waits for',
    (await insp(`[...b.querySelectorAll('.deprow')][0].textContent`) as unknown as string).includes('Task 0'))
  check('and what waits on it',
    (await insp(`b.textContent`) as unknown as string).includes('Nothing else can start until this is done'))
  // NO `\s` INSIDE THESE TEMPLATE LITERALS. Everything passed to `q`/`insp` is
  // page source inside a backtick string, so `\s` is processed as an escape and
  // arrives at the browser as a bare `s` — a `/\s+/g` written here becomes
  // `/s+/g` and replaces the letter, which is why this check first reported that
  // the inspector does not say "starts". Match on the two words instead.
  check('it quotes the scheduled start and end',
    (t2 => t2.includes('starts ') && t2.includes('ends '))
      (await insp(`b.textContent`) as unknown as string))
  // THE RULE, NOT THE FIXTURE. This read "#bord exists and #fill does not", which
  // was a true sentence about one plan and stopped being true the moment that plan
  // grew a second fill. Asking the channel editor how many values each channel HAS
  // and the inspector which controls it DREW states the actual rule: a channel
  // under two values draws nothing, because a control with one option asks a
  // question with one answer.
  check('the inspector draws a control for exactly the channels with two or more values',
    (await q(`(() => {
       const ids = { lanes: 'lane', borders: 'bord', fills: 'fill', shapes: 'shp' };
       const want = Object.keys(ids).filter(k =>
         document.querySelectorAll('#ch-' + k + ' .chit:not(.chhdr)').length >= 2);
       const got = Object.keys(ids).filter(k => !!document.querySelector('#insp #' + ids[k]));
       return JSON.stringify(want) === JSON.stringify(got) ? 'match' : JSON.stringify(want) + ' vs ' + JSON.stringify(got);
     })()`) as unknown as string) === 'match',
    await q(`(() => {
       const ids = { lanes: 'lane', borders: 'bord', fills: 'fill', shapes: 'shp' };
       return Object.entries(ids).map(([k, id]) =>
         k + ':' + document.querySelectorAll('#ch-' + k + ' .chit:not(.chhdr)').length +
         (document.querySelector('#insp #' + id) ? '/shown' : '/hidden')).join(' ');
     })()`) as unknown as string)

  // TYPING RENAMES THE BAR AS YOU TYPE, which is half of what the field is for —
  // "the audience watches it happen". One command per keystroke, last-write-wins.
  await page.evaluate(`(() => { const el = document.querySelector('#insp #lab');
                                el.focus(); el.setSelectionRange(6, 6); })()`)
  await page.keyboard.type('X')
  await settle()
  check('typing in the name box renames the row live',
    (await q(`document.querySelector('#insp #lab').value`) as unknown as string) === 'Task 2X'
      && (await q(`document.body.textContent.includes('Task 2X')`) as unknown as boolean) === true)
  check('the caret stays where it was typed',
    (await q(`document.querySelector('#insp #lab').selectionStart`) as unknown as number) === 7,
    `caret ${await q(`document.querySelector('#insp #lab').selectionStart`)}`)
  // THE SAME DISCRIMINATOR AS THE MILESTONE ROW, on the field that motivated the
  // whole mechanism. Before the port this was FALSE by construction: every
  // keystroke rebuilt `#insp` from a template, so the focused <input> was
  // destroyed and `emit(cmd, "#lab")` handed focus to its replacement. That
  // rebuild is also what fired a spurious `blur` mid-word and opened the mentions
  // dialog in front of someone still typing.
  await page.evaluate(`(document.querySelector('#insp #lab').__survived = 'yes')`)
  await page.keyboard.type('!')
  await settle()
  check('the name field is the SAME element after a render, with no keep selector',
    (await q(`(() => { const el = document.querySelector('#insp #lab');
       return el.__survived === 'yes' && document.activeElement === el; })()`) as unknown as boolean) === true)

  // A SIGN-OFF IS ABOUT A WORDING AND CANNOT OUTLIVE IT. The whole point of
  // deriving refinement from a date the applier clears, rather than from a
  // checkbox: there must be no way to change what a task SAYS and leave it
  // looking approved. Checked on the label here because the label was just
  // edited, and on the duration below because it is the third trigger and the
  // one nobody would think of.
  //
  // THE FALSIFIER IS THE SECOND HALF. "Refining sets a date" passes against a
  // plain field; only "and editing the text clears it again" distinguishes this
  // from a checkbox somebody has to remember to untick.
  await page.evaluate(`document.querySelector('#insp #refn').click()`)
  await settle()
  const refinedAt = await q(`document.querySelector('#insp #ref-at').value`) as unknown as string
  check('the now button signs a task off',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(refinedAt), refinedAt || '(empty)')
  await page.evaluate(`(() => { const el = document.querySelector('#insp #lab');
    el.focus(); })()`)
  await page.keyboard.type('?')
  await settle()
  check('and editing the title withdraws it, because the sign-off was about that title',
    (await q(`document.querySelector('#insp #ref-at').value`) as unknown as string) === '',
    `${refinedAt} -> ${await q(`document.querySelector('#insp #ref-at').value`) || '(empty)'}`)

  // THE SAME EVENT, READ THE OTHER WAY ROUND. Voiding the sign-off and stamping
  // `updatedAt` are one line in the applier, so the Changed row has to appear at
  // the moment the title is edited and say so in words. This is the only check
  // that covers the whole chain — the page stamping `at` on the way out, the
  // shared applier reading it off the command rather than off a clock, and the
  // inspector rendering it — and none of that is reachable from a unit test.
  const touched = await q(`(document.querySelector('#insp #touched') || {}).textContent || ''`) as unknown as string
  check('and the Changed row appears with it, because the same edit stamped updatedAt',
    /edited/.test(touched), touched || '(no Changed row)')

  // THE ELEMENT, not a regex over the panel's text. It was anchored on a date,
  // and a same-day task now says a clock time there instead ("ends 4:18pm").
  const endsText = () => insp(`b.querySelector('.finfo b:nth-of-type(2)').textContent`) as unknown as Promise<string>
  const endsBefore = await endsText()
  // TYPED AND THEN BLURRED, because that is what a person does and it is now the
  // only thing that commits. The field is a `<CommitField>`: React's `onChange`
  // is the DOM `input` event, so wiring `#dur` to it would fire `setDuration` per
  // CHARACTER — typing "17" would send a command saying 1 first. A synthetic
  // `change` event, which is what this check used against the imperative panel,
  // is now seen by nothing.
  await page.evaluate(`(() => { const d = document.querySelector('#insp #dur');
                                d.focus(); d.select(); })()`)
  await page.keyboard.type('17h')
  await page.evaluate(`document.querySelector('#insp #dur').blur()`)
  await settle()
  check('changing the duration moves the end date',
    (await endsText()) !== endsBefore, `${endsBefore} -> ${await endsText()}`)
  // "17h" IN, "17h" OUT. The field is painted through `fmtDur`, which carries the
  // unit on every magnitude it returns; durations are hours only (ADR 0014), so
  // a bare "17" or "17d" would be refused.
  check('the duration field shows what the document holds after committing',
    (await q(`document.querySelector('#insp #dur').value`) as unknown as string) === '17h')

  await page.evaluate(`(() => { const l = document.querySelector('#insp #lane');
    l.value = 'B'; l.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await settle()
  // A ROW CARRIES NO LANE ID — the lane is the `.lane-head` it sits under, which
  // is what "the row moved teams" actually looks like on screen.
  check('changing the team moves the row to that lane',
    (await q(`(() => {
       let n = [...document.querySelectorAll('#grid .row')]
         .find(r => r.querySelector('.rowlabel')?.textContent.includes('Task 2X'));
       while (n && !n.classList.contains('lane-head')) n = n.previousElementSibling;
       return n ? n.textContent : 'no lane head';
     })()`) as unknown as string).includes('Team B'))

  check('clicking a dependency chip selects that task',
    (await q(`(document.querySelector('#insp .deprow .chip[data-go]').click(), true)`) as unknown as boolean)
      && (await new Promise(r => setTimeout(() => r(true), 200)))
      && (await q(`document.querySelector('#insp #lab').value`) as unknown as string) === 'Task 0')

  await pick('Task 2X')
  const depsBefore = await insp(`b.querySelectorAll('.deprow .chip[data-go]').length`) as unknown as number
  await page.evaluate(`document.querySelector('#insp .deprow .chip button[data-rm]').click()`)
  await settle()
  check('removing a dependency chip drops the edge',
    (await insp(`b.querySelectorAll('.deprow .chip[data-go]').length`) as unknown as number) < depsBefore,
    `${depsBefore} chips -> ${await insp(`b.querySelectorAll('.deprow .chip[data-go]').length`)}`)

  // ---- THE THREE LENSES, AND THE TWO EDITS THAT CHANGE THE TASK LIST --------
  //
  // Chain focus, the text filter and the legend are the three ways rows go
  // missing, and "show everything" has to clear all three — a button that leaves
  // half the chart hidden is a broken promise. None of chain focus, the filter,
  // duplicate or delete had a check.
  await selectTask('t2')
  await page.evaluate(`document.querySelector('#insp #eye').click()`)
  await settle()
  check('the eye marks which task the chain is drawn around',
    (await q(`!!document.querySelector('#grid .bar.eyed')`) as unknown as boolean) === true
      && (await q(`document.querySelector('#insp #eye').classList.contains('on')`) as unknown as boolean) === true)
  check('and dims everything outside that chain',
    (await q(`document.querySelectorAll('#grid .row.dim').length`) as unknown as number) > 0,
    `${await q(`document.querySelectorAll('#grid .row.dim').length`)} dimmed`)
  check('"show everything" appears once a lens is on, and names the chain',
    (await q(`document.getElementById('clearfilter').hidden`) as unknown as boolean) === false
      && (await q(`document.getElementById('clearfilter').textContent`) as unknown as string).includes('chain focused'))

  await setNative('#q', 'Task 1')
  await settle()
  const shown = await q(`document.querySelectorAll('#grid .row:not(.dim)').length`) as unknown as number
  const total = await q(`document.querySelectorAll('#grid .row').length`) as unknown as number
  check('the find box narrows the chart', shown > 0 && shown < total, `${shown} of ${total} undimmed`)
  await page.evaluate(`document.getElementById('clearfilter').click()`)
  await settle()
  check('one "show everything" clears the chain, the text and the legend together',
    (await q(`document.querySelectorAll('#grid .row.dim').length`) as unknown as number) === 0
      && (await q(`document.getElementById('q').value`) as unknown as string) === ''
      && (await q(`!document.querySelector('#grid .bar.eyed')`) as unknown as boolean) === true
      && (await q(`document.getElementById('clearfilter').hidden`) as unknown as boolean) === true)

  // ---- THE LEGEND COUNTS NARROW TO WHAT THE FILTERS LET THROUGH --------------
  //
  // FACETED COUNTS, OWN CHANNEL LEFT OUT. A chip in channel C counts the tasks that
  // pass the done gate, the find box, the chain focus and every pick but C's own.
  // The oracle is the chart itself: in isolate mode the rows on screen ARE the
  // tasks passing every filter, so a single-valued channel's column (one task, one
  // value) has to sum to that row count. A rule that kept the plan-wide figures, or
  // one that also applied C's own pick, fails the sums below in opposite directions.
  const fclick = async (id: string) => {
    await page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`)
    await settle()
  }
  const lgChip = async (fv: string) => {
    await page.evaluate(`document.querySelector('#legend .it[data-fv="${fv}"]').click()`)
    await settle()
  }
  const numsOf = (g: string) => q(`[...document.querySelectorAll('#legend .g-${g} .it .lgc')]
    .map(e => parseInt(e.textContent, 10))`) as unknown as Promise<number[]>
  const sumOf = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const SINGLE = ['lanes', 'borders', 'fills', 'shapes', 'status']
  /** Every group's chip numbers, keyed by group, in chip order. */
  const allNums = async () => {
    const gs = await q(`[...document.querySelectorAll('#legend .grp')].map(e => e.className.match(/g-(\\w+)/)[1])`) as unknown as string[]
    const out: Record<string, number[]> = {}
    for (const g of gs) if (g !== 'view') out[g] = await numsOf(g)
    return out
  }
  /** The numbers in dim mode, then in isolate mode with the rows on screen, then
   *  back to dim — so the lens is part of what is measured. */
  const measure = async () => {
    const dim = await allNums()
    await fclick('isolate')
    const iso = await allNums()
    const rowsOn = await rowCount()
    await fclick('isolate')
    return { dim, iso, rowsOn }
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  /** Single-valued columns that disagree with the rows on screen, naming them. */
  const offColumns = (m: { dim: Record<string, number[]>; rowsOn: number }, skip: string[] = []) =>
    SINGLE.filter(g => m.dim[g] && !skip.includes(g) && sumOf(m.dim[g]) !== m.rowsOn)
      .map(g => `${g}=${sumOf(m.dim[g])}`)
  const sameShape = (a: Record<string, number[]>, b: Record<string, number[]>) =>
    same(Object.keys(a), Object.keys(b)) && Object.keys(a).every(g => a[g].length === b[g].length)

  const base = await measure()
  check('with nothing filtered, every single-valued column sums to the rows on the chart',
    offColumns(base).length === 0, `rows ${base.rowsOn}; off: ${offColumns(base)}`)

  // ONE PICK. c2 ("Second") is carried by some tasks, so the pick really narrows.
  await lgChip('colors|c2')
  const c2 = await measure()
  check('with one colour picked, every other channel sums to the rows that colour leaves',
    c2.rowsOn < base.rowsOn && offColumns(c2, ['colors']).length === 0,
    `rows ${base.rowsOn} -> ${c2.rowsOn}; columns still off: ${offColumns(c2, ['colors'])}`)
  check('and the colour chips themselves keep their counts, own pick excluded',
    same(c2.dim.colors, base.dim.colors), `colours ${base.dim.colors} -> ${c2.dim.colors}`)
  check('and flipping the isolate switch never changes a number',
    same(c2.dim, c2.iso), `dim ${JSON.stringify(c2.dim)} vs isolate ${JSON.stringify(c2.iso)}`)
  check('and which chips and groups exist is unchanged',
    sameShape(base.dim, c2.dim))

  // TWO PICKS: AND across channels. Env b1 ("none") on top of colour c2; the
  // borders column then counts under the colour pick alone (its own pick is out).
  await lgChip('borders|b1')
  const c2b1 = await measure()
  check('two picks in two channels narrow by AND, each channel leaving its own pick out',
    offColumns(c2b1, ['colors', 'borders']).length === 0
      && same(c2b1.dim.borders, c2.dim.borders) && sumOf(c2b1.dim.borders) === c2.rowsOn,
    `rows ${c2b1.rowsOn}; off: ${offColumns(c2b1, ['colors', 'borders'])}; borders ${c2.dim.borders} -> ${c2b1.dim.borders}`)

  // A PICK THAT EMPTIES THE CHART leaves every chip on screen reading 0, faded.
  // (Env b2 is carried by no task that also has colour c2.)
  await lgChip('borders|b2')
  await lgChip('borders|b1')
  const lgNone = await measure()
  check('a pick that leaves no rows still shows every chip, reading 0',
    lgNone.rowsOn === 0 && sameShape(base.dim, lgNone.dim)
      && offColumns(lgNone, ['colors', 'borders']).length === 0,
    `rows ${lgNone.rowsOn}; ${JSON.stringify(lgNone.dim)}`)
  check('and a chip at 0 is marked faded',
    (await q(`!!document.querySelector('#legend .it.zero')`) as unknown as boolean) === true)
  await fclick('clearfilter')
  const cleared = await measure()
  check('"show everything" returns every count to the unfiltered figures',
    same(cleared.dim, base.dim) && same(cleared.iso, base.iso), JSON.stringify(cleared.dim))

  // THE `*` NOTE ON THE COLOUR HEADING is arithmetic: "N tasks carry more than one
  // colour, so these counts add up to more than the M tasks on the chart". M must be
  // the population of the colour chips, so with Env b1 picked it is b1's rows.
  await lgChip('borders|b1')
  const noted = await q(`document.querySelector('#legend .g-colors b')?.title || ''`) as unknown as string
  const mN = noted.match(/^(\d+) unfinished tasks? carr\w* more than one colour.*more than the (\d+) tasks/)
  const b1 = await measure()
  check('the colour note counts the same population as its chips',
    !!mN && Number(mN[2]) === b1.rowsOn && Number(mN[1]) === b1.dim.colors[1],
    `${noted} (rows ${b1.rowsOn}, second colour ${b1.dim.colors[1]})`)
  await fclick('clearfilter')

  // THE FIND BOX.
  await setNative('#q', 'Task 1')
  await settle()
  const lgFound = await measure()
  check('the find box narrows the counts like a chip pick',
    lgFound.rowsOn > 0 && lgFound.rowsOn < base.rowsOn && offColumns(lgFound).length === 0,
    `rows ${lgFound.rowsOn} of ${base.rowsOn}; off: ${offColumns(lgFound)}`)
  await fclick('clearfilter')

  // THE CHAIN FOCUS. A task other than the one already selected: selecting the
  // selected task again CYCLES the inspector's size (app.ts, `pick`), which would
  // leave the panel a size the checks below do not expect.
  await selectTask('t4')
  await page.evaluate(`document.querySelector('#insp #eye').click()`)
  await settle()
  const chained = await measure()
  check('chain focus narrows the counts like a chip pick',
    chained.rowsOn > 0 && chained.rowsOn < base.rowsOn && offColumns(chained).length === 0,
    `rows ${chained.rowsOn} of ${base.rowsOn}; off: ${offColumns(chained)}`)
  await fclick('clearfilter')

  // THE DONE TOGGLE WITH A PICK ACTIVE. Env b2 ("prod") is carried by finished work
  // (t3). Off: finished tasks leave every count except the Status chips, which count
  // their own state — so Done reads the same either way and the other columns lose it.
  await lgChip('borders|b2')
  const onB2 = await measure()
  await fclick('showdone')
  const offB2 = await measure()
  await fclick('showdone')
  const doneChip = (m: typeof onB2) => m.dim.status[m.dim.status.length - 1]
  check('the done toggle still counts finished work only when on, under a pick',
    doneChip(onB2) > 0 && doneChip(offB2) === doneChip(onB2)
      && offColumns(offB2, ['borders', 'status']).length === 0
      && offB2.rowsOn === onB2.rowsOn - doneChip(onB2)
      && sumOf(offB2.dim.status) === onB2.rowsOn,
    `on ${onB2.rowsOn} rows, off ${offB2.rowsOn}; Done chip ${doneChip(onB2)} / ${doneChip(offB2)}; off columns: ${offColumns(offB2, ['borders', 'status'])}`)
  await fclick('clearfilter')
  // SELECTION BACK WHERE THIS BLOCK FOUND IT (t2). The checks below re-select t2 and
  // count on that being the second click, which grows the inspector one size.
  await selectTask('t2')

  // DUPLICATE AND DELETE change the task list, which is what every count in this
  // file is measured against — so they are checked by difference, not by number.
  const nRows = () => q(`document.querySelectorAll('#grid .row').length`) as unknown as Promise<number>
  await selectTask('t2')
  const beforeDup = await nRows()
  await page.evaluate(`document.querySelector('#insp #dup').click()`)
  await settle()
  check('Duplicate adds a row and moves the selection to the copy',
    (await nRows()) === beforeDup + 1
      && (await q(`document.querySelector('#insp #lab').value`) as unknown as string) !== '',
    `${beforeDup} -> ${await nRows()} rows, now on "${await q(`document.querySelector('#insp #lab').value`)}"`)

  // The confirm is answered by the dialog handler installed at the top of this
  // suite — without it a native dialog blocks every command that follows.
  const dlg0 = dialogs
  await page.evaluate(`document.querySelector('#insp #del').click()`)
  await settle()
  check('Delete asks first, then takes the row back off',
    dialogs > dlg0 && (await nRows()) === beforeDup,
    `${dialogs - dlg0} dialog(s), ${await nRows()} rows`)
  check('and deleting clears the selection rather than leaving it dangling',
    (await q(`document.getElementById('insp').hidden`) as unknown as boolean) === true)
  // Put a task back under the cursor for the sections that follow.
  await selectTask('t2')

  // SELECTION IS VISIBLE ON THE NAME, NOT JUST ON THE BAR. `selectTask` clicks
  // the BAR, so this also pins the cross-view claim: the two are one state, and
  // the gutter cannot be told about a selection made in the chart. The second
  // clause is the one that catches the likelier bug — a class applied to every
  // row marks nothing, and would pass a check that only asked about this row.
  check('the selected task is marked in the label gutter, and it is the only one',
    (await q(`${rowOf2('t2')}.querySelector('.rowlabel').classList.contains('sel')`) as unknown as boolean) === true
      && (await q(`document.querySelectorAll('#grid .rowlabel.sel').length`) as unknown as number) === 1,
    `${await q(`document.querySelectorAll('#grid .rowlabel.sel').length`)} marked`)

  // LINKING GOES BOTH WAYS, AND THE ONE TO CHECK IS THE NEW ONE. "Blocks…" arms
  // the original direction; "Waits for…" arms the opposite, and the whole of it
  // is one ternary in `pick()` that is equally plausible backwards. A check that
  // only asserted "a dependency appeared" would pass either way — so this
  // asserts WHICH task ended up waiting.
  //
  // t0 and t1 both start with no dependencies and neither reaches the other, so
  // the new edge cannot be a cycle. Removed again afterwards: every later check
  // in this file counts rows and dates against the fixture's own shape.
  await selectTask('t0')
  await page.evaluate(`document.querySelector('#insp #mklinkwaits').click()`)
  await settle()
  check('the linking banner says which click it wants, not which mode is on',
    /must be done before/.test(await q(`document.querySelector('#insp .linkmsg')?.textContent || ''`) as unknown as string),
    await q(`document.querySelector('#insp .linkmsg')?.textContent || '(no banner)'`) as unknown as string)
  await page.evaluate(`${rowOf2('t1')}.querySelector('.bar').click()`)
  await settle()
  await selectTask('t0')
  check('"Waits for…" makes THIS task the one that waits, not the other way round',
    (await q(`document.querySelector('#insp .deprow').textContent`) as unknown as string).includes('Task 1'),
    await q(`document.querySelector('#insp .deprow').textContent`) as unknown as string)
  await page.evaluate(`fetch('/api/commands', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: { type: 'removeDep', id: 't0', dep: 't1' } }) })`)
  await settle()
  await selectTask('t2')

  // THE LINK POPOVER, which is `position:fixed` to escape the panel's clip. Both
  // of these were dropped in the first pass of the React port and caught by
  // reading the old handler list, not by a failing check — so they get one.
  await page.evaluate(`document.querySelector('#insp #urlbtn').click()`)
  await settle()
  check('opening the link popover puts the caret in the URL field',
    (await q(`(() => { const p2 = document.getElementById('urlpop');
       return !p2.hidden && document.activeElement === document.getElementById('url'); })()`) as unknown as boolean) === true)
  check('it is placed above its button and inside the window',
    (await q(`(() => { const p2 = document.getElementById('urlpop').getBoundingClientRect();
       return p2.left >= 8 && p2.right <= innerWidth + 1 && p2.width > 0; })()`) as unknown as boolean) === true)
  // Escape ABANDONS, and must not reach the page's global Escape — which clears
  // the selection and would close the whole panel.
  await page.keyboard.press('Escape')
  await settle()
  // BOTH HALVES NULL-SAFE. If Escape reaches the page's global handler the
  // selection is cleared and the panel empties, so `#urlpop` is GONE rather than
  // hidden — a plain `.hidden` read throws there and takes the run down with a
  // puppeteer trace instead of naming this check. Losing the panel is the very
  // failure being tested for, so it has to be expressible as `false`.
  check('Escape closes the popover without losing the selection',
    (await q(`(() => ({
       closed: document.getElementById('urlpop')?.hidden !== false,
       kept: !!document.querySelector('#insp #lab'),
     }))()`) as unknown as { closed: boolean; kept: boolean }).closed === true
      && (await q(`!!document.querySelector('#insp #lab')`) as unknown as boolean) === true,
    JSON.stringify(await q(`(() => ({
       popover: document.getElementById('urlpop') ? (document.getElementById('urlpop').hidden ? 'closed' : 'open') : 'gone',
       panel: document.querySelector('#insp #lab') ? 'kept' : 'cleared',
     }))()`)))

  // OPTIONAL, so a regression upstream REPORTS rather than stack-traces. Proving
  // the Escape check above by removing its `stopPropagation` made the global
  // handler clear the selection, which emptied the panel — and this line then
  // threw on a null `#dismiss`, killing the run with a puppeteer trace instead of
  // printing which check failed. The exit code was still right; the message was
  // useless, which is most of what a suite is for.
  // ---- ACTUALS AND CONSTRAINTS ----------------------------------------------
  //
  // None of this had a test. All of it changes the SCHEDULE, which is the one
  // thing in this tool that must not be quietly wrong: an actual start beats the
  // dependencies and the queue, an actual finish replaces the estimate as the
  // bar's width, and "not before" is a constraint the scheduler honours.
  await selectTask('t5')

  // WORK IS SESSIONS (ADR 0016): start puts the task in progress and draws its elapsed strip; there is no
  // typed start any more, and no way back to Not started once it has one.
  const AS = '2026-01-07T09:00', AE = '2026-01-16T17:00'
  await page.evaluate(`document.querySelector('#insp #workstart').click()`)
  await settle()
  check('start puts the task in progress and draws its elapsed strip',
    (await q(`!!${rowOf2('t5')}.querySelector('.elapsed')`) as unknown as boolean) === true
      && (await q(`!${rowOf2('t5')}.querySelector('.rowlabel').classList.contains('done')`) as unknown as boolean) === true)
  check('and offers stop and finish, and no way to remove its only session',
    (await q(`!!document.querySelector('#insp #workstop') && !!document.querySelector('#insp #workfinish')
      && !document.querySelector('#insp #sx0')`) as unknown as boolean) === true)

  // THE LEGEND COUNTS WHAT IS DRAWN. Summed across the whole lane column rather
  // than read off one chip: a lane is single-valued, so the column sums to the
  // number of tasks on the chart, and a total that moves by exactly one cannot
  // be satisfied by a chip that happened to re-render.
  //
  // MEASURED BOTH WAYS ROUND THE TOGGLE, which is the whole claim and needs
  // both halves: hiding finished work must take the task OFF the count, and
  // showing it must leave it ON. Either half alone passes for a rule that
  // ignores the toggle — which is exactly what this shipped as for an hour.
  //
  // `showAllRows` ticks `done` after every load, so ON is the state this file
  // runs in; each measurement puts it back.
  const laneTotal = () => q(`[...document.querySelectorAll('#legend .g-lanes .lgc')]
    .reduce((a, e) => a + parseInt(e.textContent, 10), 0)`) as unknown as Promise<number>
  const tick = async (id: string) => {
    await page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`)
    await settle()
  }
  const bothWays = async () => {
    const on = await laneTotal()
    await tick('showdone')
    const off = await laneTotal()
    await tick('showdone')
    return { on, off }
  }
  const was = await bothWays()
  await page.evaluate(`document.querySelector('#insp #workfinish').click()`)
  await settle()
  const after = await bothWays()
  // THE SESSION PUT BACK TO WHEN THE WORK REALLY HAPPENED, which is how a time is corrected now: nine days, so the
  // bar is wide enough to carry the estimate tick and the grip checked below.
  await setNative('#insp #ss0', AS)
  await settle()
  await setNative('#insp #se0', AE)
  await settle()
  check('the legend counts follow the done toggle rather than a rule of their own',
    after.on === was.on && after.off === was.off - 1,
    `shown ${was.on}->${after.on} (expected no change), hidden ${was.off}->${after.off} (expected -1)`)

  // THE CANCELLED BLOCK THAT WAS HERE IS GONE (2026-09-20), with the concept.
  // Five checks covered a `cancelled` toggle, a Cancelled status chip, and the
  // precedence rule that made a task which was both finished AND cancelled
  // follow the cancelled toggle. Work decided against is deleted now, and
  // `removeTask` is covered by the Delete check further up.

  check('finishing strikes the row through and draws the estimate tick',
    (await q(`${rowOf2('t5')}.querySelector('.rowlabel').classList.contains('done')`) as unknown as boolean) === true
      && (await q(`!!${rowOf2('t5')}.querySelector('.esttick')`) as unknown as boolean) === true)
  check('the inspector says how it went against the estimate',
    /estimate|early|over/.test(await q(`document.querySelector('#insp #est')?.textContent || ''`) as unknown as string),
    await q(`document.querySelector('#insp #est')?.textContent || '(no #est)'`) as unknown as string)
  // THE GRIP IS STILL THERE — it is rendered on WIDTH, not on finishedness — and
  // it is the DRAG that is refused, because a finished bar's width is its observed
  // span, so editing `dur` would move a control and change nothing on screen.
  // (I first wrote this check asserting the grip was gone. It is not.)
  // SCROLLED CLEAR FIRST, AND CHECKED. The inspector is pinned OVER the chart, so
  // a row underneath it takes no pointer events — the mouse lands on the panel and
  // the drag never reaches the bar. That failed silently as "no refusal message",
  // which reads like the guard is missing rather than like the click missed.
  await page.evaluate(`${rowOf2('t5')}.scrollIntoView({ block: 'center' })`)
  await settle()
  const gripBox = await boxOf(`${rowOf2('t5')}.querySelector('.bar .grip')`)
  const onTop = gripBox && (await q(`(() => {
    const e = document.elementFromPoint(${Math.round((gripBox?.x ?? 0) + (gripBox?.w ?? 0) / 2)},
                                       ${Math.round((gripBox?.y ?? 0) + (gripBox?.h ?? 0) / 2)});
    return !!e && e.classList.contains('grip');
  })()`) as unknown as boolean)
  check('the grip is reachable by a pointer, not buried under the pinned panel',
    onTop === true, `grip box ${JSON.stringify(gripBox)}`)
  if (gripBox && onTop) {
    // CLEARED FIRST. `flash` leaves its text up for 3.5s, so without this the
    // check reads the refusal from the FUTURE-DATE test a few lines above and
    // reports a pass or a failure about the wrong thing entirely.
    await page.evaluate(`document.getElementById('msg').textContent = ''`)
    await page.mouse.move(gripBox.x + gripBox.w / 2, gripBox.y + gripBox.h / 2)
    await page.mouse.down()
    await page.mouse.move(gripBox.x + gripBox.w / 2 + 60, gripBox.y + gripBox.h / 2)
    await page.mouse.up()
    await settle()
    check('dragging a finished bar\'s grip is refused, and says why',
      (await msg()).includes('actually took'), await msg())
    check('and the work it is protecting is unchanged',
      (await q(`document.querySelector('#insp #se0').value`) as unknown as string) === AE)
  }

  // REOPENING KEEPS THE WORK: the task is paused, its session where it was.
  await page.evaluate(`document.querySelector('#insp #workreopen').click()`)
  await settle()
  check('reopening un-finishes the task and keeps its session, paused',
    (await q(`!${rowOf2('t5')}.querySelector('.rowlabel').classList.contains('done')`) as unknown as boolean) === true
      && (await q(`!!document.querySelector('#insp #workstart')`) as unknown as boolean) === true
      && (await q(`document.querySelector('#insp #ss0').value`) as unknown as string) === AS)
  // t5 STAYS WORKED ON — work once recorded stays recorded (ADR 0016) — so what follows uses t7, never started:
  // a not-before pins only a forecast.
  await selectTask('t7')

  // THE "MARK DONE" CHECK IS GONE BECAUSE THE BUTTON IS. `#markdone` was removed
  // in 42824a3 (the readable-inspector pass) and now exists nowhere but here —
  // which is why this file did not merely fail, it CRASHED: `querySelector(...)
  // .click()` on null threw, took the run down mid-suite, and every check after
  // this line went unreported rather than red. A test for a control nobody ships
  // is not coverage, so it goes rather than getting a replacement gesture
  // invented for it. What it was really asserting — that done-ness is two dates
  // and both have to be present — is covered above by start, finish and reopen, and
  // in the scheduler suite by REFERENCE_ACT.

  // NOT BEFORE is a constraint, not a position: typed dates are kept even when
  // they stop binding.
  await setNative('#insp #nb', '2026-02-02T09:00')
  await settle()
  check('a not-before constraint pins the bar and says so on it',
    (await q(`${rowOf2('t7')}.querySelector('.bar').classList.contains('pin')`) as unknown as boolean) === true
      && (await q(`${rowOf2('t7')}.querySelector('.bar').title`) as unknown as string).includes('cannot start before'))
  await page.evaluate(`document.querySelector('#insp #nbx').click()`)
  await settle()
  check('and clearing it unpins',
    (await q(`${rowOf2('t7')}.querySelector('.bar').classList.contains('pin')`) as unknown as boolean) === false)

  // IGNORES THE QUEUE: work that does not occupy the team neither waits for a
  // free slot nor holds one.
  const endsBefore2 = await q(`document.querySelector('#insp .finfo b:nth-of-type(2)').textContent`) as unknown as string
  await page.evaluate(`(() => { const c = document.querySelector('#insp #noq');
    c.click(); })()`)
  await settle()
  check('"ignores the queue" is recorded on the task',
    (await q(`document.querySelector('#insp #noq').checked`) as unknown as boolean) === true)
  check('and it changes when the work can start, or honestly says it did not',
    typeof (await q(`document.querySelector('#insp .finfo b:nth-of-type(2)').textContent`)) === 'string',
    `${endsBefore2} -> ${await q(`document.querySelector('#insp .finfo b:nth-of-type(2)').textContent`)}`)
  await page.evaluate(`document.querySelector('#insp #noq').click()`)
  await settle()

  // THE THREE PERSONAL FIELDS, checked here because the CLI and this panel have
  // to stay capability-equal: anything `tl` can set has to be settable by hand,
  // or the UI quietly becomes read-only for half the model.
  //
  // DUE IS NOT A MILESTONE and not a constraint — the scheduler ignores it and
  // reports against it, so what is asserted is the SLACK, which is the only
  // reason the field is worth having.
  await setNative('#insp #due', '2030-01-01T09:00')
  await settle()
  check('a deadline reports slack against the date the scheduler computed',
    /to spare|misses by/.test(await q(`document.querySelector('#insp #dueslack')?.textContent || ''`) as unknown as string),
    await q(`document.querySelector('#insp #dueslack')?.textContent || '(none)'`) as unknown as string)
  await page.evaluate(`document.querySelector('#insp #duex').click()`)
  await settle()
  check('and clearing the deadline takes the slack with it',
    (await q(`!document.querySelector('#insp #dueslack')`) as unknown as boolean) === true)


  // THE ONE SHORTCUT THE NATIVE PICKER CANNOT OFFER. Chrome's popup draws Clear
  // and Today and cannot be added to, so `now` is our own button on all four
  // date rows. Two minutes of tolerance, because the clock is real.
  //
  // WHAT THIS DOES NOT CATCH, said out loud: the field carries minutes, so a
  // stale render-time snapshot would pass here too — the panel is only seconds
  // old. That the time is read at CLICK time is held by the TYPE instead
  // (`nowISO: () => string`); a value prop is the version of this that could
  // rot, and it is not the one that shipped.
  await page.evaluate(`document.querySelector('#insp #duen').click()`)
  await settle()
  check('the now button stamps a date field with the current time',
    Math.abs(Date.parse((await q(`document.querySelector('#insp #due').value`) as unknown as string) + 'Z') - +planWall()) < 120000,
    await q(`document.querySelector('#insp #due').value`) as unknown as string)
  await page.evaluate(`document.querySelector('#insp #duex').click()`)
  await settle()

  // THE OWNER FIELD WAS CHECKED HERE. It is gone (2026-09-20) — somebody else's
  // work is their own task, named after them in the title, with `noQueue` set so
  // their days do not eat your capacity. The queue exemption is what actually
  // did the work and it is checked on its own above.

  // THE CANCEL BUTTON WAS CHECKED HERE. It is gone (2026-09-20) — "decided not
  // to" is `removeTask` now, and Delete is covered further up.

  await page.evaluate(`document.querySelector('#insp #dismiss')?.click()`)
  await settle()
  check('dismiss closes the panel',
    (await q(`document.getElementById('insp').hidden`) as unknown as boolean) === true)

  // ---- SAVING, REVERTING, AND THE COMPARISON LENS ---------------------------
  //
  // SAVING AND CHANGING ARE DIFFERENT ACTS and neither had a check. A command
  // changes the live draft for everyone the moment you make it; Save is what turns
  // that draft into an archived version, and the note is the only description a
  // human ever gets of what you did.
  const s0 = (await probe()).saves
  await page.evaluate(`document.getElementById('save').click()`)
  await settle()
  check('Save asks for a note before it writes anything',
    (await q(`document.getElementById('savepop').hidden`) as unknown as boolean) === false
      && (await probe()).saves === s0)
  await setNative('#savenote', 'a note from the suite')
  await page.evaluate(`document.getElementById('save').click()`)
  await settle()
  check('and a second click is what sends it',
    (await probe()).saves === s0 + 1, `${s0} -> ${(await probe()).saves} save(s)`)
  check('the last-change card then says when, on the milestone row',
    (await q(`!!document.querySelector('#msbar .lastsave')`) as unknown as boolean) === true,
    await q(`(document.querySelector('#msbar .lastsave') || {}).textContent || '(absent)'`) as unknown as string)

  // ---- HOW MUCH OF IT IS LEFT -----------------------------------------------
  //
  // "Whole plan" counts the document, finished work included, so on a plan
  // half-done the headline is a number about the past. The second line is the
  // one somebody is reading the card for, and the rule that makes it worth
  // having is that it VANISHES where it would only repeat the first — otherwise
  // it is two ways of saying eleven and a reader hunts for the difference.
  //
  // The fixture has exactly one task with both actuals (`t3`), so the live plan
  // is 11 tasks with 1 done, which is the interesting state without arranging
  // anything.
  const cardLines = async (title: string) => JSON.parse(await q(`JSON.stringify((() => {
    const c = [...document.querySelectorAll('#msbar .ms.empty')]
      .find(e => (e.querySelector('.nm') || {}).textContent === ${JSON.stringify(title)});
    if (!c) return null;
    return { all: [...c.querySelectorAll('.dt')].map(e => e.textContent),
             left: (c.querySelector('.dt.left') || {}).textContent ?? null };
  })())`) as unknown as string) as { all: string[]; left: string | null } | null
  const whole = await cardLines('Whole plan')
  check('Whole plan says how much of itself is still to do, under the total',
    /^11 tasks · /.test(whole?.all[0] ?? '') && /^10 left · /.test(whole?.left ?? ''),
    JSON.stringify(whole))
  // ORDER IS PART OF THE CONTRACT: several checks read the compare line as the
  // LAST `.dt` in this card, and "what there is, what is left, what it is
  // measured against" is the reading order anyway.
  check('and the remaining line sits under the total, not after the compare line',
    (whole?.all.indexOf(whole.left!) ?? -1) === 1, JSON.stringify(whole?.all))

  // Day numbers of the fixture, sent as the instants a command carries (v6).
  const at = (n: number) => instantOfDay(n, { start: '2026-01-05' })
  const send = (cmd: unknown) =>
    fetch(`http://127.0.0.1:${PORT}/api/commands`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })

  // COMPARE IS A LENS AND MOVES NOTHING. It paints where a version put every bar
  // UNDER the live chart — the one reading nothing else on screen offers.
  await page.evaluate(`document.getElementById('histbtn').click()`)
  await until(`document.querySelectorAll('#hist-list .hcmp').length > 1`, 'the History rows')
  await page.evaluate(`document.querySelectorAll('#hist-list .hcmp')[1].click()`)
  await settle()
  check('comparing paints a baseline strip under the bars',
    (await q(`document.querySelectorAll('#grid .baseline').length`) as unknown as number) > 0,
    `${await q(`document.querySelectorAll('#grid .baseline').length`)} baseline(s)`)
  check('and says which version, beside "Whole plan"',
    (await q(`(document.querySelector('#msbar .ms.empty .dt:last-child') || {}).textContent || ''`) as unknown as string)
      .includes('vs save'),
    await q(`(document.querySelector('#msbar .ms.empty .dt:last-child') || {}).textContent || '(none)'`) as unknown as string)
  check('the inspector reports the variance against it',
    (await q(`!!document.querySelector('#insp #var') || document.getElementById('insp').hidden`) as unknown as boolean) === true)
  await page.evaluate(`document.querySelectorAll('#hist-list .hcmp')[1].click()`)
  await settle()
  check('turning it off takes the baselines away again',
    (await q(`document.querySelectorAll('#grid .baseline').length`) as unknown as number) === 0)
  await page.evaluate(`document.getElementById('hist-close').click()`)
  await settle()

  // ---- THE OTHER TWO VIEWS, AND ZOOM ----------------------------------------
  //
  // Timeline answers WHEN, Elapsed answers HOW LONG SO FAR, Graph answers WHAT
  // WAITS ON WHAT. Neither of the other two touches the schedule, and none of
  // them had a check.
  const barLefts = () => q(`JSON.stringify([...document.querySelectorAll('#grid .row .bar')]
     .slice(0, 5).map(b => Math.round(parseFloat(b.style.left))))`) as unknown as Promise<string>
  const timelineLefts = await barLefts()
  await setNative('#view', 'relative', 'HTMLSelectElement')
  await settle()
  check('Elapsed re-lays the bars without changing how many there are',
    (await barLefts()) !== timelineLefts
      && (await q(`document.querySelectorAll('#grid .row .bar').length`) as unknown as number) === 11,
    `${timelineLefts} -> ${await barLefts()}`)
  await setNative('#view', 'timeline', 'HTMLSelectElement')
  await settle()
  check('and switching back puts them where they were',
    (await barLefts()) === timelineLefts)

  // THE GRAPH LENS NOW DRAWS HERE, and it did not use to. Cytoscape was imported
  // from a CDN this harness has no route to, so the only thing this block could
  // test was the FAILURE being handled — a lens that cannot load saying so
  // rather than leaving an empty box that reads as "no dependencies". It is a
  // bundled dependency since the plan became somewhere a whole task list lives
  // and "the graph needs the internet" stopped being acceptable offline.
  //
  // Both branches stay asserted. The failure path is still real (a broken chunk,
  // a browser that refuses the import) and is still the more dangerous of the
  // two, because an empty box is a confident wrong answer.
  await setNative('#view', 'graph', 'HTMLSelectElement')
  // The import either resolves or rejects, and until it does the page is still —
  // so quiescence would read a lens that has not finished failing yet and report
  // "drew" for an empty box.
  await until(`!!document.getElementById('cyfail')
    || document.querySelectorAll('#cy canvas, #cy svg').length > 0`,
    'the graph lens to draw or say why it could not')
  check('the graph lens either draws or says why it could not',
    (await q(`(() => {
       const failed = !!document.getElementById('cyfail');
       const drew = document.querySelectorAll('#cy canvas, #cy svg').length > 0;
       return failed || drew;
     })()`) as unknown as boolean) === true,
    await q(`document.getElementById('cyfail') ? 'reported: ' + document.getElementById('cyfail').textContent.slice(0, 60) : 'drew'`) as unknown as string)
  check('and the row controls hide with it, rather than offering an order you cannot see',
    (await q(`(() => { const z = document.getElementById('zoomwrap');
       return !z || getComputedStyle(z).display === 'none' || z.hidden; })()`) as unknown as boolean) === true)
  // READINESS IS A RIM COLOUR, so the view's own report is the only assertable
  // thing about it. This fixture has a real chain in it, so a correct tiering
  // must use more than one tier — a run where everything lands in `ready` means
  // the dependency graph was not consulted at all, which is the failure worth
  // catching and the one a single-tier plan would hide.
  //
  // Tiers partition the unfinished tasks, so they cannot outnumber the nodes.
  // Started and finished work is in neither, which is why this is `<=` and not
  // an equality.
  const tiers = await q(`(() => {
    const g = document.getElementById('cy');
    const r = g && g.dataset.graph ? JSON.parse(g.dataset.graph) : null;
    return r ? JSON.stringify({ tiers: r.tiers, n: r.n }) : 'no report';
  })()`) as unknown as string
  check('and it says how far each task is from being actionable',
    (() => {
      if (tiers === 'no report') return false
      const { tiers: t, n } = JSON.parse(tiers)
      if (!t) return false
      const counts = Object.values(t) as number[]
      const total = counts.reduce((a, b) => a + b, 0)
      return total > 0 && total <= n && Object.keys(t).length > 1
    })(), tiers)

  // A HAND-ARRANGED GRAPH IS WORK, so it goes in the document (`graphPos`)
  // rather than into localStorage with the zoom and the fold. What is asserted
  // here is the MECHANISM: that the view reports a node's position, and that
  // "Arrange" throws the arrangement away.
  //
  // THE DRAG GESTURE ITSELF IS NOT ASSERTED HERE, deliberately. Simulating it
  // against this fixture produced a `moveTaskInLane` from the timeline rather
  // than the node move — the node did move, and the graph redrew, but the
  // command that reached the wire came from somewhere else, and chasing that
  // was costing more than the coverage was worth. The gesture is verified
  // end-to-end against a real sync server instead (drag, reload, the position
  // is still there, "Arrange" clears it). If someone breaks drag-to-persist,
  // this file will not catch it — that is a known hole, written down rather
  // than papered over with a check that passes for the wrong reason.
  {
    const aim = await page.evaluate(`(() => {
      const el = document.getElementById('cy'), r = el.getBoundingClientRect();
      const g = JSON.parse(el.dataset.graph || '{}').grab || [];
      return JSON.stringify(g.map(n => ({ id: n.id, x: r.x + n.x, y: r.y + n.y })));
    })()`) as unknown as string
    const nodes = JSON.parse(aim) as { id: string; x: number; y: number }[]
    check('the graph says where its nodes are, so a drag can aim at them',
      nodes.length >= 2, aim)

    // DRAGGING BETWEEN TWO NODES DRAWS A DEPENDENCY, once "Link dependency" has
    // armed it — and only then, so a plain drag still moves a node.
    //
    // ASSERTED BY COMMAND TYPE, NOT BY COUNTING. The first attempt at this
    // snapshotted the wire's length and diffed it afterwards, which races with
    // anything still in flight from an earlier step: it reported a
    // `moveTaskInLane` from the timeline and looked exactly like a bug in the
    // graph. Driving the same drag against a real server left the task order
    // byte-identical, so the app was fine and the check was not.
    if (nodes.length >= 2) {
      const [from, to] = nodes as [{ id: string; x: number; y: number }, { id: string; x: number; y: number }]
      const seen = async () => ((await probe()) as { wire: { type: string; id?: string; dep?: string }[] })
        .wire.filter(c => c.type === 'addDep').map(c => `${c.id}<-${c.dep}`)
      const had = await seen()

      // Select the source, then arm the gesture the way a person does.
      await page.mouse.click(from.x, from.y)
      await settle()
      const selected = await q(`(JSON.parse(document.getElementById('cy').dataset.graph||'{}').sel)||'NONE'`) as unknown as string
      check('clicking a node on the graph selects it', selected === from.id, `${selected} (wanted ${from.id})`)
      // ARMED FROM THE PANEL, which is the only place it can be armed since the
      // toolbar button went (2026-09-20). This is the check that proves the
      // graph's half of the mode came with it: `armLink` enables draw mode, and
      // if that had been left behind in the deleted handler the drag below
      // would pan instead of drawing an edge.
      await page.evaluate(`document.querySelector('#insp #mklink').click()`)
      await settle()
      // DWELL BEFORE PRESSING. With snapping off the handle only appears after
      // `hoverDelay`, so a move-then-immediately-press starts a pan instead of
      // an edge and the gesture never fires.
      await page.mouse.move(from.x, from.y)
      await new Promise((r) => setTimeout(r, 400))
      await page.mouse.move(from.x + 2, from.y)
      await new Promise((r) => setTimeout(r, 300))
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 24 })
      await new Promise((r) => setTimeout(r, 200))
      await page.mouse.up()
      await settle()

      const now = await seen()
      const added = now.filter(x => !had.includes(x))
      check('dragging between two nodes with linking armed draws a dependency',
        added.length === 1 && added[0] === `${to.id}<-${from.id}`,
        `${JSON.stringify(added)} (wanted ${to.id}<-${from.id})`)
    }

    const before = ((await probe()) as { wire: unknown[] }).wire.length
    await page.evaluate(`document.getElementById('garrange').click()`)
    await settle()
    const sent = ((await probe()) as { wire: { type: string; patch?: Record<string, unknown> }[] })
      .wire.slice(before)
    // NOTHING TO CLEAR, SO NOTHING IS SENT. This fixture has never been
    // arranged, and the falsifier is a button that patches the document every
    // time it is pressed — writing `graphPos: null` onto a plan that never had
    // one, which archives a version and dirties the plan for a no-op.
    check('and Arrange sends nothing when there is no arrangement to throw away',
      sent.length === 0, `${sent.length} command(s): ${JSON.stringify(sent).slice(0, 120)}`)
  }

  await setNative('#view', 'timeline', 'HTMLSelectElement')
  await settle()

  // ZOOM IS HOW MUCH TIME FILLS THE WINDOW, so it changes the pixels per day and
  // nothing about the plan.
  const wide = await q(`Math.round(document.querySelector('#grid .row .bar').getBoundingClientRect().width)`) as unknown as number
  // PUT BACK AFTERWARDS. Zoom changes pixels-per-day, and the drag checks further
  // down move the pointer a fixed number of PIXELS to cross a DAY — so leaving the
  // chart zoomed out makes a 90px drag mean nothing and they fail for a reason
  // that has nothing to do with dragging.
  const zoomWas = await q(`document.getElementById('zoom').value`) as unknown as string
  const opts = await q(`JSON.stringify([...document.querySelectorAll('#zoom option')].map(o => o.value))`) as unknown as string
  const pick2 = JSON.parse(opts).find((v: string) => v !== '' && v !== (JSON.parse(opts)[0]))
  if (pick2 !== undefined) {
    await setNative('#zoom', pick2, 'HTMLSelectElement')
    await settle()
    check('zooming changes the width of a bar and not the number of them',
      (await q(`Math.round(document.querySelector('#grid .row .bar').getBoundingClientRect().width)`) as unknown as number) !== wide
        && (await q(`document.querySelectorAll('#grid .row .bar').length`) as unknown as number) === 11,
      `bar ${wide}px -> ${await q(`Math.round(document.querySelector('#grid .row .bar').getBoundingClientRect().width)`)}px`)
    await setNative('#zoom', zoomWas, 'HTMLSelectElement')
    await settle()
    check('and putting the zoom back restores the width it had',
      (await q(`Math.round(document.querySelector('#grid .row .bar').getBoundingClientRect().width)`) as unknown as number) === wide)
  }

  // ---- SETTINGS: the two editors that were rebuilt on every render ----------
  //
  // `#wwedit` and `#arrowedit` sit inside Settings, which is usually shut, and
  // were `innerHTML =` on the render path anyway — so every keystroke anywhere in
  // the plan rebuilt two panels nobody was looking at. Nothing covered them.
  await page.evaluate(`document.getElementById('cog').click()`)
  await settle()
  check('settings opens', (await q(`document.getElementById('settings').hidden`) as unknown as boolean) === false)

  // THE WORKING CALENDAR (ADR 0021) is a scheduler input: edits must move the finish, shade the
  // off-hours, and leave the page's own audit with nothing to say.
  const day = (k: string) => `#wwedit .wkrow[data-day="${k}"]`
  const finish = () => q(`document.querySelector('#msbar .ms .dt').textContent`) as unknown as Promise<string>
  const inputs = (sel: string) => q(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel + ' input')})].map(i => [i.value, i.getAttribute('aria-label')]))`)
    .then(v => JSON.parse(v as unknown as string)) as Promise<[string, string][]>
  const lastWire = async () => ((await probe()) as { wire: { type: string; patch?: any }[] }).wire.at(-1)
  const rowsText = () => q(`JSON.stringify([...document.querySelectorAll('#wwedit .wkrow[data-day]')].map(r => [r.dataset.day, r.querySelector('.hoff')?.textContent ?? '']))`)
    .then(v => JSON.parse(v as unknown as string)) as Promise<[string, string][]>
  const click = (sel: string) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`)

  const rows0 = await rowsText()
  check('Settings lists the seven weekdays, Monday first, each reading "Any hour" while no hours are set',
    rows0.map(r => r[0]).join() === 'mon,tue,wed,thu,fri,sat,sun' && rows0.every(r => r[1] === 'Any hour'), JSON.stringify(rows0))
  check('and says that no hours means every hour is working time',
    /every hour is working time/.test(await q(`document.getElementById('wwedit').textContent`) as unknown as string))
  const endBefore = await finish()
  await click(`${day('mon')} .hadd`)
  await settle()
  check('adding a window to Monday gives it a labelled pair of time inputs, 09:00 to 17:00',
    JSON.stringify(await inputs(day('mon'))) === JSON.stringify([['09:00', 'Monday window 1 start'], ['17:00', 'Monday window 1 end']]),
    JSON.stringify(await inputs(day('mon'))))
  const wired = await lastWire()
  check('and sends one patchDoc carrying hours.week.mon',
    wired?.type === 'patchDoc' && JSON.stringify(wired.patch?.hours?.week?.mon) === '[["09:00","17:00"]]', JSON.stringify(wired))
  const rows1 = await rowsText()
  check('every other weekday now reads Off', rows1.filter(r => r[0] !== 'mon').every(r => r[1] === 'Off'), JSON.stringify(rows1))
  check('and the finish moved', (await finish()) !== endBefore, `${endBefore} -> ${await finish()}`)
  check('the hours outside the window are shaded', (await q(`document.querySelectorAll('#grid .nwd').length`) as unknown as number) > 0)

  await click(`${day('mon')} .hadd`)
  await settle()
  check('a second window on the same day opens an hour after the first ends',
    JSON.stringify((await inputs(day('mon'))).map(i => i[0])) === '["09:00","17:00","18:00","23:59"]', JSON.stringify(await inputs(day('mon'))))
  const wiresBefore = ((await probe()) as { wire: unknown[] }).wire.length
  await setNative(`${day('mon')} .hwin:nth-child(2) .hs`, '16:00')
  await settle()
  check('moving it to overlap the first is refused with a message, sends nothing, and puts the time back',
    /overlap/.test(await q(`document.getElementById('msg').textContent`) as unknown as string)
      && ((await probe()) as { wire: unknown[] }).wire.length === wiresBefore
      && (await inputs(day('mon')))[2]![0] === '18:00')
  await click(`${day('mon')} [aria-label="Remove Monday window 2"]`)
  await click(`${day('mon')} [aria-label="Remove Monday window 1"]`)
  await settle()
  const rows2 = await rowsText()
  check('removing the last window puts the week back to "Any hour", and the finish with it',
    rows2.every(r => r[1] === 'Any hour') && (await finish()) === endBefore, `${JSON.stringify(rows2)} ${await finish()}`)

  const row = (iso: string) => `#wwedit .wkrow[data-date="${iso}"]`
  await setNative('#hovnew', '2031-01-01')
  await click('#hovadd')
  await settle()
  check('a date override is added as a day off, listed, and the date field clears itself',
    (await q(`document.querySelector(${JSON.stringify(row('2031-01-01') + ' .hoff')})?.textContent`) as unknown as string) === 'Off'
      && (await q(`document.getElementById('hovnew').value`) as unknown as string) === '')
  await click(`${row('2031-01-01')} .hadd`)
  await settle()
  const wired2 = await lastWire()
  check('giving it a window sends hours.dates for that date',
    JSON.stringify(wired2?.patch?.hours?.dates?.['2031-01-01']) === '[["09:00","17:00"]]', JSON.stringify(wired2))
  await click(`${row('2031-01-01')} [aria-label="Remove the override for 2031-01-01"]`)
  await settle()
  check('removing the override takes the row away',
    (await q(`document.querySelectorAll(${JSON.stringify(row('2031-01-01'))}).length`) as unknown as number) === 0)

  check('the arrow editor draws a swatch per relationship',
    (await q(`document.querySelectorAll('#arrowedit .arrit svg line').length`) as unknown as number) === 4)

  // ---- SETTINGS -> CHANNELS -------------------------------------------------
  //
  // The last panel on the render path built by `innerHTML`, and the one that held
  // THREE of the four `emit(cmd, keep)` call sites — the channel name, each value
  // name, and a lane's short name are all `oninput` text fields. Nothing covered
  // any of it.
  // SETTINGS HAS TABS, and `#chedit` is not on the one that opens. Everything here
  // was reading a panel in a `display:none` tab: the DOM queries answered
  // perfectly well, and every click and focus went nowhere — which reported as
  // "the legend did not update" about an edit that was never made.
  await page.evaluate(`document.querySelector('#settings [data-tab="channels"]').click()`)
  await settle()
  check('the Channels tab opens', (await q(`getComputedStyle(document.getElementById('chedit')).display`) as unknown as string) !== 'none')

  check('a block per channel, each with a row per value',
    (await q(`document.querySelectorAll('#chedit .chrow').length`) as unknown as number) === 5
      && (await q(`document.querySelectorAll('#ch-lanes .chit:not(.chhdr)').length`) as unknown as number) === 2)
  // SUMMING TO THE PLAN, not two fixed numbers: an earlier check moves a task
  // between teams, so hardcoding 6 and 5 makes this depend on the order the suite
  // happens to run in — which is how a characterisation check quietly becomes a
  // test of its own fixture.
  check('each value reports how many tasks use it',
    (await q(`[...document.querySelectorAll('#ch-lanes .chit:not(.chhdr) .use')]
       .reduce((a, e) => a + +e.textContent, 0)`) as unknown as number) === 11,
    await q(`[...document.querySelectorAll('#ch-lanes .chit:not(.chhdr) .use')].map(e => e.textContent).join()`) as unknown as string)

  // THE CHANNEL'S NAME IS THE PLAN'S VOCABULARY, so renaming it here has to reach
  // the legend and the inspector. That crosses three React regions and the
  // document, which is exactly why it is worth one check.
  // `page.focus`, NOT `el.focus()` inside an evaluate. The evaluate form left
  // `document.activeElement` on <body> here — the field never took the caret, the
  // keystroke went nowhere, and the check reported "the legend did not update"
  // about an edit that was never made.
  await page.focus('#ch-lanes [data-chname]')
  await page.evaluate(`(() => { const el = document.querySelector('#ch-lanes [data-chname]');
    el.setSelectionRange(el.value.length, el.value.length); })()`)
  await page.keyboard.type('s')
  await settle()
  check('renaming a channel reaches the legend, with the caret intact',
    (await q(`document.querySelector('#legend .g-lanes b').textContent`) as unknown as string).startsWith('Teams')
      && (await q(`document.activeElement === document.querySelector('#ch-lanes [data-chname]')`) as unknown as boolean) === true,
    `field ${JSON.stringify(await q(`document.querySelector('#ch-lanes [data-chname]').value`))} ` +
    `legend ${JSON.stringify(await q(`document.querySelector('#legend .g-lanes b').textContent`))} ` +
    `focused ${await q(`document.activeElement && document.activeElement.className`)}`)

  const laneRows = () => q(`document.querySelectorAll('#ch-lanes .chit:not(.chhdr)').length`) as unknown as Promise<number>
  await page.evaluate(`document.querySelector('#ch-lanes [data-addch]').click()`)
  await settle()
  check('+ Add appends a value', (await laneRows()) === 3)
  await page.evaluate(`[...document.querySelectorAll('#ch-lanes .chit:not(.chhdr) .rm')].pop().click()`)
  await settle()
  check('and × takes it back off, after confirming',
    (await laneRows()) === 2 && dialogs > 0,
    `${await laneRows()} rows, ${dialogs} dialog(s) answered`)

  // ---- SETTINGS -> SWAP -----------------------------------------------------
  // "These labels are moving there, and this is what they will look like" is the
  // whole job of the panel, so what it has to get right is the two directions and
  // the warnings about what you lose.
  await page.evaluate(`document.querySelector('#settings [data-tab="swap"]').click()`)
  await settle()
  check('swap shows a column per direction, each headed with the move',
    (await q(`[...document.querySelectorAll('#swapmap .swapcol b')].map(e => e.textContent).join(' / ')`) as unknown as string)
      .split(' / ').length === 2,
    await q(`[...document.querySelectorAll('#swapmap .swapcol b')].map(e => e.textContent).join(' / ')`) as unknown as string)
  check('and a row per value on the source channel',
    (await q(`document.querySelectorAll('#swapmap .swapcol:first-child .swaprow').length`) as unknown as number) > 0)

  // COLLIDING STYLES ARE ALLOWED AND CALLED OUT — the "you are going to lose some
  // granularity" case, and the only one. Forcing both borders onto one style is
  // the shortest way to provoke it.
  const picks = await q(`document.querySelectorAll('#swapmap .swapcol:first-child select[data-sw]').length`) as unknown as number
  if (picks >= 2) {
    const firstStyle = await q(`document.querySelector('#swapmap .swapcol:first-child select[data-sw]').value`) as unknown as string
    await setNative('#swapmap .swapcol:first-child .swaprow:nth-of-type(2) select[data-sw]',
                    firstStyle, 'HTMLSelectElement')
    await settle()
    check('two values landing on one style are warned about, by name',
      (await q(`document.querySelectorAll('#swapmap .swapcol:first-child .swapwarn b').length`) as unknown as number) > 0,
      await q(`(document.querySelector('#swapmap .swapwarn') || {}).textContent || 'no warning'`) as unknown as string)
  }
  await page.evaluate(`document.querySelector('#settings [data-tab="channels"]').click()`)
  await settle()

  // NO CHANNEL CAN BE EMPTIED. Every task points at a real value in every channel,
  // so the last one is not arbitrary — it is what the whole plan is pointing AT.
  await page.evaluate(`document.querySelector('#ch-fills .chit:not(.chhdr) .rm').click()`)
  await settle()
  check('the last value in a channel refuses to go',
    (await q(`document.querySelectorAll('#ch-fills .chit:not(.chhdr)').length`) as unknown as number) === 1)

  // ---- THE ORDER PANEL ------------------------------------------------------
  //
  // Queue order is a scheduling input that leaves no trace in the document and no
  // arrow on the chart, so a plan can be weeks wrong with every duration and
  // dependency correct. This panel is the only thing that says so. On a plan this
  // small the answer is computed locally rather than by `/api/reorder`, so what is
  // under test is the real `suggestReorders`, not the stub.
  await page.evaluate(`document.getElementById('set-close').click()`)
  await settle()
  // THE CHIP IS NOT PART OF THE RENDER THAT PROVOKES IT. `scheduleNudge` runs the
  // search after the chart is already drawn and quiet, so asking whether the chip
  // is there the moment the DOM stops moving is asking too early — and the answer
  // silently takes the `else` branch, which reads as "this plan has nothing to
  // move" and skips the panel entirely. `soon` rather than `until` because the
  // other branch is a legitimate outcome on a different fixture.
  //
  // A KNOWN IMPROVABLE ORDER, SET UP HERE. This check used to open whatever the
  // chip already showed, and at this point in the run the fixture's queues are
  // dependency chains with nothing to improve — the chip only said "2 rows could
  // move" because that answer was left over from an earlier state, and the check
  // passed when it read the panel before the fresh search replaced it ("Order
  // looks fine") and failed, 1 run in 9, when it did not. So: a one-hour task due
  // tomorrow at the BACK of lane A, behind days of chained work, misses its
  // deadline, and moving it forward is a strict improvement every time.
  const relay = (cmd: unknown) => fetch(`http://127.0.0.1:${PORT}/api/commands`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
  await relay({ type: 'addTask', at: new Date().toISOString(), task: { id: 'urgent', label: 'Urgent',
    lane: 'A', dur: 60, deps: [], color: ['c1'], border: 'b1', fill: 'f1', shape: 's1',
    due: new Date(Date.now() + 864e5).toISOString() } })
  await settle()
  const orderChip = await until(`/could move/.test(document.querySelector('#msbar .ms.reord:not(.busy)')?.textContent || '')`,
                                'the Order chip to find the move this test set up', 15000)
  if (orderChip) {
    await page.evaluate(`document.querySelector('#msbar .ms.reord').click()`)
    await settle()
    // AND THE ANSWER IS ABOUT THIS PLAN: our Urgent task is in it. Until the
    // fresh search lands the chip still shows whatever it said before.
    await until(`[...document.querySelectorAll('#reorder-body .rsug')].some(r => r.textContent.includes('Urgent'))`,
                'the Order panel to show the move this test set up', 15000)
    check('the Order panel opens and every row carries what it costs',
      (await q(`document.getElementById('reorder').hidden`) as unknown as boolean) === false
        && (await q(`document.querySelectorAll('#reorder-body .rsug').length`) as unknown as number) > 0
        && (await q(`[...document.querySelectorAll('#reorder-body .rsug')].every(r => r.querySelector('.gain'))`) as unknown as boolean),
      `${await q(`document.querySelectorAll('#reorder-body .rsug').length`)} suggestion(s)`)

    // APPLYING ONE INVALIDATES THE REST — every entry was measured against the
    // order that was current when the list was built. So the rows go DEAD, not
    // dim: a stale suggestion is still a valid command, it just would not do what
    // its own label promises.
    await page.evaluate(`document.querySelector('#reorder-body [data-apply]').click()`)
    await settle()
    check('applying one puts the rest out of action until they are recomputed',
      (await q(`[...document.querySelectorAll('#reorder-body [data-apply],#reorder-body [data-sortlanes]')]
         .every(b => b.disabled)`) as unknown as boolean) === true
        && (await q(`document.querySelector('#reorder-body .hint b') !== null`) as unknown as boolean) === true,
      await q(`(document.querySelector('#reorder-body .hint') || {}).textContent || 'no banner'`) as unknown as string)

    // APPLY ALL RUNS UNTIL THERE IS NOTHING LEFT, and the claim worth pinning is
    // that it CONVERGES rather than that it clicks: it re-measures after every
    // move, so it stops on its own and leaves an empty list behind. If it never
    // stopped, the `until` below would time out rather than the check failing —
    // which is the right failure for a loop that edits a shared document.
    //
    // THE ONE MOVE ABOVE MAY ALREADY HAVE BEEN ENOUGH, and on this fixture it
    // sometimes is — the panel then renders "Nothing to move" and there is no
    // Apply all button to press. That is convergence too, so the check accepts
    // it rather than the suite depending on how many moves this plan happens to
    // need. What is NOT accepted is a list that still has advice on it.
    await until(`!document.querySelector('#reorder-body .hint b')`,
                'the recompute after the single apply', 30000)
    if (await q(`!!document.querySelector('#reorder-body [data-applyall]')`)) {
      await page.evaluate(`document.querySelector('#reorder-body [data-applyall]').click()`)
      await settle()
      await until(`!document.querySelector('#reorder-body [data-stopapplyall]')`,
                  'Apply all to run out of suggestions', 60000)
    }
    check('Apply all runs to convergence and leaves nothing to apply',
      (await q(`document.querySelectorAll('#reorder-body [data-apply]').length`) as unknown as number) === 0,
      await q(`document.querySelectorAll('#reorder-body [data-apply]').length + ' suggestion(s) left'`) as unknown as string)

    // THE RANKING (2026-09-26): "which should happen first?", asked a pair at a time on
    // the Order panel's Rank tab with the pairwise-sorter's own elements. What is pinned
    // here is the page's half — the chip that always offers it, the cards, and that an
    // answer or an undo becomes exactly one command; what the answers MEAN (the order,
    // the tie-break) is shared code and lives in sync-server/test/ranking.test.ts.
    const badge = async () => Number(await q(`document.querySelector('#msbar .ms.reord .obadge[data-unranked]')?.dataset.unranked || 0`))
    await page.evaluate(`document.getElementById('reorder-close').click()`)
    await settle()
    const unranked = await badge()
    check('the Order chip counts the tasks nobody has ranked yet', unranked >= 2, `${unranked} unranked`)
    await page.evaluate(`document.querySelector('#msbar .ms.reord').click()`)
    await page.evaluate(`document.getElementById('otab-rank').click()`)
    await settle()
    check('the Rank tab asks about two tasks, each as the Inspector would show it',
      (await q(`document.querySelector('#rank-body pairwise-compare')?.shadowRoot?.querySelectorAll('[data-taskcard]').length || 0`) as unknown as number) === 2,
      await q(`document.getElementById('rank-body').textContent.slice(0, 120)`) as unknown as string)
    const wireAt = async () => ((await probe()) as { wire: { type: string }[] }).wire
    const asked = async () => await q(`JSON.stringify([...(document.querySelector('#rank-body pairwise-compare')
      ?.shadowRoot?.querySelectorAll('[data-taskcard]') || [])].map(c => c.dataset.taskcard).sort())`) as unknown as string
    // A DEPENDENCY ANSWERS THE QUESTION ITSELF. Once one task of the pair on screen waits
    // on the other there is only one possible answer, so the page stops asking — and says
    // nothing to the server, because nothing was answered. The later task is made to wait
    // on the earlier: the fixture only ever waits downward, so that cannot close a cycle.
    const before = await asked()
    const [lo, hi] = (JSON.parse(before) as string[]).sort((x, y) => +x.slice(1) - +y.slice(1))
    const wd = (await wireAt()).length
    await relay({ type: 'addDep', id: hi!, dep: lo! })
    await settle()
    const after = await asked()
    check('a pair a dependency decides is not asked', !!hi && after !== before, `${before} -> ${after}`)
    check('and nothing is sent for it', (await wireAt()).slice(wd).every(c => c.type !== 'addRankAnswer'),
      JSON.stringify((await wireAt()).slice(wd)))
    await relay({ type: 'removeDep', id: hi!, dep: lo! })
    await settle()
    const w0 = (await wireAt()).length
    await page.keyboard.press('ArrowLeft')
    await settle()
    const answered = (await wireAt()).slice(w0)
    check('an answer sends exactly one addRankAnswer', answered.length === 1 && answered[0]!.type === 'addRankAnswer',
      JSON.stringify(answered))
    // PLACING A TASK TAKES ABOUT log2(n) ANSWERS, so the badge is watched across a few.
    let given = 1
    while ((await badge()) >= unranked && given < 8) { await page.keyboard.press('ArrowLeft'); await settle(); given++ }
    check('and the chip counts down', (await badge()) < unranked, `${await badge()} of ${unranked} after ${given} answer(s)`)
    const w1 = (await wireAt()).length
    await page.keyboard.press('Backspace')
    await settle()
    const undone = (await wireAt()).slice(w1)
    check('undo sends exactly one removeRankAnswer', undone.length === 1 && undone[0]!.type === 'removeRankAnswer',
      JSON.stringify(undone))
    // The rest of the run expects a plan nobody has ranked.
    for (let i = 1; i < given; i++) { await page.keyboard.press('Backspace'); await settle() }
    await page.evaluate(`document.getElementById('reorder-close').click()`)
    await settle()
    await page.evaluate(`document.querySelector('.bar').click()`)
    await settle()
    check('the Inspector says where a task stands in the ranking',
      /not ranked yet| of \d+/.test(await q(`document.getElementById('rankval')?.textContent || ''`) as unknown as string),
      await q(`document.getElementById('rankval')?.textContent || 'no rank row'`) as unknown as string)
    check('and the converged panel says so, in words',
      (await q(`document.getElementById('reorder-body').textContent`) as unknown as string).includes('Nothing to move'))
    await page.evaluate(`document.getElementById('reorder-close').click()`)

    // PAST PLANS (ADR 0020): a planned stretch that is over asks whether it happened, on the Review panel's third tab.
    // Pinned here: the chip counts them and opens on them, oldest first; the two-step keys send the same commands the
    // Inspector's own controls send; Enter takes the default for the kind of task; Esc backs out of the second step
    // without closing the panel. Two tasks of its own, removed again, so the rest of the run sees the fixture.
    const ago = (h: number) => new Date(Date.now() - h * 36e5).toISOString()
    await relay({ type: 'addTask', task: { id: 'past-a', label: 'Past A', dur: 60, planned: [{ start: ago(5), stop: ago(4) }] } })
    await relay({ type: 'addTask', task: { id: 'past-b', label: 'Past B', dur: 60, planned: [{ start: ago(3), stop: ago(2) }] } })
    await settle()
    const pastN = async () => await q(`document.querySelector('#msbar .ms.reord .obadge[data-past]')?.dataset.past || '0'`) as unknown as string
    check('the Review chip counts the planned stretches that are over', (await pastN()) === '2', `${await pastN()} past`)
    await page.evaluate(`document.querySelector('#msbar .ms.reord').click()`)
    await settle()
    const pastText = async () => await q(`document.getElementById('past-body').textContent`) as unknown as string
    check('and opens on Past plans, oldest first',
      (await q(`document.getElementById('otab-past').getAttribute('aria-selected')`) as unknown as string) === 'true'
        && (await pastText()).includes('Past A'), (await pastText()).slice(0, 120))
    const sentSince = async (n: number) => (await wireAt()).slice(n).map(c => c.type)
    const wp = (await wireAt()).length
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Escape')
    await settle()
    check('Esc backs out of the second step, not out of the panel, and sends nothing',
      (await q(`document.getElementById('reorder').hidden`) as unknown as boolean) === false
        && (await q(`document.querySelector('#past-body .past-answer').dataset.step`) as unknown as string) === 'ask'
        && (await sentSince(wp)).length === 0, JSON.stringify(await sentSince(wp)))
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await settle()
    check('→ → (happened, finished) sends completePlanned then finishTask',
      JSON.stringify(await sentSince(wp)) === '["completePlanned","finishTask"]', JSON.stringify(await sentSince(wp)))
    check('and the next stretch is up', (await pastText()).includes('Past B'), (await pastText()).slice(0, 120))
    const wq = (await wireAt()).length
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Enter')
    await settle()
    check('← Enter on your own work keeps the task without the stretch: one setPlanned',
      JSON.stringify(await sentSince(wq)) === '["setPlanned"]', JSON.stringify(await sentSince(wq)))
    check('and with nothing left the tab says so', (await q(`!!document.getElementById('past-none')`) as unknown as boolean) === true
      && (await pastN()) === '0', (await pastText()).slice(0, 120))
    await page.evaluate(`document.getElementById('reorder-close').click()`)
    await relay({ type: 'removeTask', id: 'past-a' })
    await relay({ type: 'removeTask', id: 'past-b' })
    await settle()

    // THE NOTICE (`doc.notice`): free text above the chart. Pinned here: it renders as markdown with links
    // that open away; × hides it in this browser until the text changes; ✎ lands in the Settings editor,
    // whose typing patches the document; null clears it.
    const notice = () => q(`document.getElementById('notice').textContent`) as unknown as Promise<string>
    await relay({ type: 'patchDoc', patch: { notice: 'Calendar synced **2:05 PM** https://example.com/log' } })
    await settle()
    check('a notice shows above the chart, as markdown', (await notice()).includes('Calendar synced 2:05 PM')
      && (await q(`!!document.querySelector('#notice .notice-text strong')`) as unknown as boolean), await notice())
    check('and its links open away from the plan',
      (await q(`document.querySelector('#notice a')?.getAttribute('rel') || ''`) as unknown as string).includes('noopener'))
    await page.evaluate(`document.querySelector('#notice .notice-strip button[title^="Hide"]').click()`)
    await settle()
    check('× hides it to a chip', (await q(`!!document.querySelector('#notice .notice-chip') && !document.querySelector('#notice .notice-strip')`) as unknown as boolean))
    await relay({ type: 'patchDoc', patch: { notice: 'Calendar synced 3:05 PM' } })
    await settle()
    check('and a changed notice shows again', (await notice()).includes('3:05 PM')
      && (await q(`!!document.querySelector('#notice .notice-strip')`) as unknown as boolean), await notice())
    await page.evaluate(`document.querySelector('#notice .notice-strip button[title^="Edit"]').click()`)
    await settle()
    check('✎ opens Settings on the notice editor',
      (await q(`document.activeElement?.id`) as unknown as string) === 'noticeedit'
        && (await q(`document.getElementById('noticeedit').value`) as unknown as string) === 'Calendar synced 3:05 PM')
    await page.evaluate(`(() => { const t = document.getElementById('noticeedit');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Typed here');
      t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await settle()
    check('typing in the editor changes the notice', (await notice()).includes('Typed here'), await notice())
    await page.evaluate(`document.getElementById('set-close').click()`)
    await relay({ type: 'patchDoc', patch: { notice: null } })
    await settle()
    check('and null clears it', (await q(`document.getElementById('notice').childElementCount`) as unknown as number) === 0)


    // A SUGGESTION IS SHOWN WHERE THE PERSON DECIDES (2026-10-03): under each card of the pair they are
    // answering, and in the Inspector. There is no banner and no button for it on the page: a
    // suggestion orders the queue beneath their answers by itself. What it MEANS (the seeding, finishing a
    // task, a dependency, steering) is shared code and lives in sync-server/test/rank-suggestion.test.ts;
    // what is pinned here is the page's half.
    const aiNotes = () => q(`JSON.stringify([...document.querySelector('#rank-body pairwise-compare').shadowRoot.querySelectorAll('.rk-ai')]
      .map(n => ({ text: n.textContent, preferred: n.dataset.preferred === '1', bg: getComputedStyle(n).backgroundColor,
                   border: getComputedStyle(n).borderTopColor })))`).then(s => JSON.parse(s as unknown as string)) as Promise<
      { text: string; preferred: boolean; bg: string; border: string }[]>
    const onScreen = async () => JSON.parse(await q(`JSON.stringify([...document.querySelector('#rank-body pairwise-compare')
      .shadowRoot.querySelectorAll('[data-taskcard]')].map(c => c.dataset.taskcard))`) as unknown as string) as string[]
    await page.evaluate(`document.querySelector('#msbar .ms.reord').click()`)
    await page.evaluate(`document.getElementById('otab-rank').click()`)
    await settle()
    check('with no suggestion the pair on screen has no AI note', (await aiNotes()).length === 0)
    const steerState = () => q(`(() => { const b = document.getElementById('rk-steer'); return JSON.stringify({ there: !!b, shown: !!b && !!b.closest('label').offsetParent, checked: !!b && b.checked }) })()`)
      .then(s => JSON.parse(s as unknown as string)) as Promise<{ there: boolean; shown: boolean; checked: boolean }>
    check('and no switch for steering Auto-order, since there is nothing to steer with', !(await steerState()).shown)
    const [leftId, rightId] = await onScreen()
    // Two tasks, exactly the pair showing; the order is the opposite of how the cards are laid out.
    const suggestPair = async (first: string, second: string) => {
      await relay({ type: 'setRankSuggestion', by: 'Claude', order: [
        { id: first, why: 'reason for the first' }, { id: second, why: 'reason for the second', toss: true }] })
      await settle()
    }
    await suggestPair(rightId!, leftId!)
    const notes = await aiNotes()
    check('each card shows where the AI put that task, and its reason', notes.length === 2
      && /^AI: #2 of 2/.test(notes[0]!.text) && /reason for the second/.test(notes[0]!.text)
      && /^AI: #1 of 2/.test(notes[1]!.text) && /reason for the first/.test(notes[1]!.text), JSON.stringify(notes))
    check('the side the AI ranks higher is a visibly different box',
      notes[1]?.preferred === true && notes[0]?.preferred === false
      && (notes[1]!.bg !== notes[0]!.bg || notes[1]!.border !== notes[0]!.border), JSON.stringify(notes))
    check('and nothing says "would pick" or "toss-up"', !notes.some(n => /would pick|toss/i.test(n.text)), JSON.stringify(notes))
    // THE ONE CONTROL A SUGGESTION HAS: whether it steers Auto-order. On unless the plan says otherwise.
    const sw0 = await steerState()
    check('with a suggestion there is a switch for steering Auto-order, on by default', sw0.shown && sw0.checked, JSON.stringify(sw0))
    const wSw = (await wireAt()).length
    await page.evaluate(`document.getElementById('rk-steer').click()`)
    await settle()
    const turnedOff = (await wireAt()).slice(wSw)
    check('turning it off sends exactly one patchDoc setting useRankSuggestion to false',
      turnedOff.length === 1 && turnedOff[0]!.type === 'patchDoc' && JSON.stringify((turnedOff[0] as { patch?: unknown }).patch) === '{"useRankSuggestion":false}', JSON.stringify(turnedOff))
    check('and it reads as off, while the notes on the pair stay', !(await steerState()).checked && (await aiNotes()).length === 2)
    await page.evaluate(`document.getElementById('rk-steer').click()`)
    await settle()
    check('turning it back on reads as on', (await steerState()).checked)
    check('there is no banner, list, Adopt or Discard on the page',
      await q(`!document.getElementById('rk-sugg') && !document.getElementById('rk-adopt') && !document.getElementById('rk-discard')`))
    await suggestPair(leftId!, rightId!)
    const flipped = await aiNotes()
    check('a new suggestion redraws the pair on screen', flipped[0]?.preferred === true && flipped[1]?.preferred === false, JSON.stringify(flipped))
    // THE PAGE CAN SUGGEST TOO (ADR 0008: what the API does the page does, for the commands that remain). One task per
    // line, an id or its exact title, with an optional reason; the suggestion is then the person's, so it says "You".
    const wire0 = (await wireAt()).length
    const fill = (text: string) => page.evaluate(`document.getElementById('rk-suggest').open = true;
      document.getElementById('rk-suggest-text').value = ${JSON.stringify(text)}`)
    await fill('nonsense that is no task\n' + leftId!)
    await page.evaluate(`document.getElementById('rk-suggest-go').click()`)
    await settle()
    check('a line that matches no task sends nothing and says which line', (await wireAt()).length === wire0
      && (await q(`document.body.textContent.includes('nonsense that is no task')`)), JSON.stringify((await wireAt()).slice(wire0)))
    await fill(`${rightId} — wins here\n${leftId}`)
    await page.evaluate(`document.getElementById('rk-suggest-go').click()`)
    await settle()
    const sent = (await wireAt()).slice(wire0).find(c => c.type === 'setRankSuggestion') as { by?: string; order?: { id: string; why: string }[] } | undefined
    check('the page sends one setRankSuggestion, in line order, with the reason or a default',
      JSON.stringify(sent?.order?.map(o => [o.id, o.why])) === JSON.stringify([[rightId, 'wins here'], [leftId, 'suggested order']]) && !!sent?.by,
      JSON.stringify(sent))
    const mine = await aiNotes()
    check('and its notes say "You", not "AI", with the person\'s own place and reason',
      mine.length === 2 && /^You: #2 of 2/.test(mine[0]!.text) && /^You: #1 of 2/.test(mine[1]!.text) && /wins here/.test(mine[1]!.text), JSON.stringify(mine))
    // A title works as well as an id, and an id with hyphens in it is not cut at them.
    await relay({ type: 'addTask', at: new Date().toISOString(), task: { id: 'hy-phen', label: 'Hy phen',
      lane: 'A', dur: 60, deps: [], color: ['c1'], border: 'b1', fill: 'f1', shape: 's1' } })
    await relay({ type: 'addTask', at: new Date().toISOString(), task: { id: 'colon-task', label: 'Colon: task',
      lane: 'A', dur: 60, deps: [], color: ['c1'], border: 'b1', fill: 'f1', shape: 's1' } })
    await settle()
    const wLabel = (await wireAt()).length
    await fill('hy-phen — hyphen reason\nTask 0: label reason\nColon: task')
    await page.evaluate(`document.getElementById('rk-suggest-go').click()`)
    await settle()
    const sent2 = (await wireAt()).slice(wLabel).find(c => c.type === 'setRankSuggestion') as { order?: { id: string; why: string }[] } | undefined
    check('an id with hyphens, a title, and a title that itself holds a colon all match, and the reasons split off after them',
      JSON.stringify(sent2?.order?.map(o => [o.id, o.why])) === JSON.stringify([['hy-phen', 'hyphen reason'], ['t0', 'label reason'], ['colon-task', 'suggested order']]),
      JSON.stringify(sent2))
    await relay({ type: 'removeTask', id: 'hy-phen' })
    await relay({ type: 'removeTask', id: 'colon-task' })
    // The Inspector says where a task sits, marked as the suggestion's and not the person's.
    const four = ((await (await fetch(`http://127.0.0.1:${PORT}/api/plan`)).json()) as { doc: { tasks: { id: string; actualEnd?: string }[] } })
      .doc.tasks.filter(t => !t.actualEnd).slice(0, 4).map(t => t.id)
    await relay({ type: 'setRankSuggestion', by: 'Claude', order: four.map(id => ({ id, why: 'reason ' + id })) })
    await settle()
    await page.evaluate(`document.getElementById('reorder-close').click()`)
    await settle()
    await pick('Task 0')
    await settle()
    const rankLine = await q(`document.getElementById('rankval')?.textContent || ''`) as unknown as string
    check('the Inspector shows the suggested place beside the person\'s, marked as not theirs',
      /^(not ranked yet|\d+ of \d+) · ≈ \d of 4 suggested$/.test(rankLine), rankLine)
    await relay({ type: 'patchDoc', patch: { useRankSuggestion: null } })
    await relay({ type: 'resetRanking' })
    await settle()
    await page.evaluate(`document.getElementById('reorder-close').click()`)
  }
  // And gone again, so the rest of the run has the fixture it expects.
  await relay({ type: 'removeTask', id: 'urgent' })
  await settle()

  // ---- THE CHART GRID: THE THREE THINGS A DRAG MEANS ------------------------
  //
  // Nothing covered any of this. The bar carries three gestures — the grip is the
  // DURATION, the body sideways is a START CONSTRAINT, the body vertically is the
  // QUEUE — and the axis is decided once on the first 4px and then held, because
  // deciding it per pointermove lets a drag flip between retiming and reordering
  // while the mouse is down, which in a meeting looks like the tool having a
  // seizure. These are real pointer events through `page.mouse`, not synthesised
  // ones, so they exercise the same listeners a hand does.
  const rowOf = (label: string) => `[...document.querySelectorAll('#grid .row')]
    .find(r => r.querySelector('.rowlabel')?.textContent.includes(${JSON.stringify(label)}))`

  const dragTarget = 'Task 8'
  await pick(dragTarget)
  await settle()
  const durBefore = durDays(await q(`document.querySelector('#insp #dur').value`) as unknown as string)!
  const grip = await boxOf(`${rowOf(dragTarget)}.querySelector('.bar .grip')`)
  check('the bar has a grip to drag', grip !== null && grip.w > 0, JSON.stringify(grip))
  if (grip) {
    await page.mouse.move(grip.x + grip.w / 2, grip.y + grip.h / 2)
    await page.mouse.down()
    // Past a working day's worth of pixels, in two steps so the axis lock and the
    // per-move preview both actually run.
    await page.mouse.move(grip.x + grip.w / 2 + 40, grip.y + grip.h / 2)
    await page.mouse.move(grip.x + grip.w / 2 + 90, grip.y + grip.h / 2)
    await page.mouse.up()
    await settle()
    // NULL-SAFE. If the gesture loses the selection the panel is empty, and a bare
    // `.value` read throws a puppeteer trace instead of naming the check.
    const durAfter = durDays(await q(`(() => { const d = document.querySelector('#insp #dur');
      return d ? d.value : null; })()`) as unknown as string | null)
    check('dragging the grip right lengthens the task',
      durAfter !== null && durAfter > durBefore,
      `${durBefore}d -> ${durAfter}d` + (durAfter === null
        ? ` (inspector empty: hidden=${await q(`document.getElementById('insp').hidden`)} rows=${await q(`document.querySelectorAll('#grid .row').length`)})` : ''))

    // A DRAG THAT ENDED WHERE IT STARTED IS NOT AN EDIT. It also covers a preview
    // that a mid-drag rollback already took back.
    const cmdsBefore = (await probe()).batches
    const g2 = await boxOf(`${rowOf(dragTarget)}.querySelector('.bar .grip')`)
    await page.mouse.move(g2!.x + g2!.w / 2, g2!.y + g2!.h / 2)
    await page.mouse.down(); await page.mouse.move(g2!.x + g2!.w / 2 + 3, g2!.y + g2!.h / 2)
    await page.mouse.move(g2!.x + g2!.w / 2, g2!.y + g2!.h / 2)       // and back: it ends where it started
    await page.mouse.up()
    await settle()
    check('a grip drag that goes nowhere changes nothing',
      durDays(await q(`(() => { const d = document.querySelector('#insp #dur');
                         return d ? d.value : null; })()`) as unknown as string | null) === durAfter
        && (await probe()).batches === cmdsBefore)
  }

  // THE BODY, VERTICALLY, IS THE QUEUE. `moveTaskInLane`'s `toIndex` is absolute
  // and lane-relative, so a whole drag is one command naming where it ended up.
  const laneOrderNow = () => q(`(() => {
     let n = ${rowOf(dragTarget)};
     while (n && !n.classList.contains('lane-head')) n = n.previousElementSibling;
     const out = []; let c = n && n.nextElementSibling;
     while (c && !c.classList.contains('lane-head')) {
       if (c.classList.contains('row')) out.push(c.querySelector('.rowlabel').textContent.trim());
       c = c.nextElementSibling;
     }
     return out.join(' | ');
   })()`) as unknown as Promise<string>
  const orderBefore = await laneOrderNow()
  // SCROLLED CLEAR FIRST, AND CHECKED — the same two lines the grip drag below
  // already needed, for the same reason and now with the evidence. The inspector
  // is pinned OVER the chart, so a row underneath it takes no pointer events:
  // the mouse lands on the panel and the drag never reaches the bar.
  // `elementFromPoint` at the drag origin was returning `fk`, an inspector field
  // label. The gesture works — it was never being asked.
  await page.evaluate(`${rowOf(dragTarget)}.scrollIntoView({ block: 'center' })`)
  await settle()
  const bar = await boxOf(`${rowOf(dragTarget)}.querySelector('.bar')`)
  const grab = bar && { x: Math.round(bar.x + Math.min(20, bar.w / 2)), y: Math.round(bar.y + bar.h / 2) }
  // NAMED, NOT SILENT. A drag that misses its target fails as "nothing moved",
  // which reads like the feature is gone rather than like the pointer landed on
  // a panel — that mis-reading cost a bug report.
  const barOnTop = grab && (await q(`(() => {
    const e = document.elementFromPoint(${grab.x}, ${grab.y});
    return !!e && !!e.closest('.bar'); })()`) as unknown as boolean)
  check('the bar the reorder drag aims at is actually under the pointer',
    barOnTop === true,
    `${JSON.stringify(grab)} hits ${await q(`(el => el ? [el.id && '#' + el.id, el.className || el.tagName, 'in', el.parentElement && (el.parentElement.id ? '#' + el.parentElement.id : el.parentElement.className || el.parentElement.tagName)].filter(Boolean).join(' ') : null)(document.elementFromPoint(${grab?.x ?? 0}, ${grab?.y ?? 0}))`)}`)
  if (bar && barOnTop && orderBefore.split(' | ').length > 1) {
    await page.mouse.move(grab!.x, grab!.y)
    await page.mouse.down()
    await page.mouse.move(grab!.x, grab!.y - 30)
    await page.mouse.move(grab!.x, grab!.y - 70)
    await page.mouse.up()
    await settle()
    check('dragging a bar vertically reorders it within its team',
      (await laneOrderNow()) !== orderBefore,
      `${orderBefore}  ->  ${await laneOrderNow()}` +
      // The page says WHY it refused a reorder — date rows, a folded lane,
      // already first or last. Carrying that here is the difference between a
      // failure you can read and one you have to reproduce by hand.
      ` | ${await q(`JSON.stringify({
          msg: document.getElementById('msg').textContent,
          rowmode: document.getElementById('rowmode').value,
        })`)}`)
  }

  // ---- THE GRID'S OTHER TWO SHAPES ------------------------------------------
  //
  // A folded lane reuses ONE row element for several bars, and date mode drops the
  // lane grouping entirely for a flat list ordered by start. Both are the cases a
  // rewrite of the row loop breaks silently, because the common shape — one row
  // per task, grouped under a head — keeps working.
  const gridShape = () => q(`JSON.stringify({
    heads: document.querySelectorAll('#grid .lane-head').length,
    rows: document.querySelectorAll('#grid .row').length,
    bars: document.querySelectorAll('#grid .row .bar').length,
  })`) as unknown as Promise<string>
  const teamShape = JSON.parse(await gridShape())
  check('team mode groups rows under a head per lane',
    teamShape.heads >= 2 && teamShape.rows === teamShape.bars, JSON.stringify(teamShape))

  // FOLDING PUTS A WHOLE TEAM ON ONE LINE — fewer rows than bars, which is the
  // invariant, and it is the one `POS[t.id].el` shares between tasks.
  await page.evaluate(`document.querySelector('#grid .lane-head.fold').click()`)
  await settle()
  const folded = JSON.parse(await gridShape())
  check('folding a team packs its bars onto fewer rows than it has tasks',
    folded.rows < teamShape.rows && folded.bars === teamShape.bars, JSON.stringify(folded))
  await page.evaluate(`document.querySelector('#grid .lane-head.fold').click()`)
  await settle()
  check('unfolding puts them back',
    (await gridShape()) === JSON.stringify(teamShape),
    `${await gridShape()} vs ${JSON.stringify(teamShape)}`)

  // DATE MODE HAS NO LANE GROUPING and its order is an ANSWER, not a queue — which
  // is why the inspector's up/down arrows go dead in it.
  await setNative('#rowmode', 'date', 'HTMLSelectElement')
  await settle()
  const dated = JSON.parse(await gridShape())
  check('date mode drops the lane heads and keeps every bar',
    dated.heads === 0 && dated.bars === teamShape.bars, JSON.stringify(dated))
  check('rows are ordered by start date',
    (await q(`(() => {
       const xs = [...document.querySelectorAll('#grid .row .bar')].map(b => parseFloat(b.style.left));
       return xs.every((x, i) => i === 0 || x >= xs[i - 1] - 0.5);
     })()`) as unknown as boolean) === true)
  await pick('Task 0')
  await settle()
  check('and the queue arrows say why they are dead',
    (await q(`document.querySelector('#insp #up').disabled`) as unknown as boolean) === true
      && (await q(`document.querySelector('#insp #up').title`) as unknown as string).includes('ordered by date'))
  await setNative('#rowmode', 'team', 'HTMLSelectElement')
  await settle()
  check('switching back restores the grouped shape',
    JSON.parse(await gridShape()).heads === teamShape.heads)

  // ---- THE ARROW LAYER, which nothing has ever checked ----------------------
  // `drawArrows` sizes `#arrows` from the grid on its FIRST line, so an unsized
  // 300x150 svg means it never ran at all — not that it ran and found nothing.
  check('the arrow layer is sized to the grid after a render',
    (await q(`(() => {
       const s2 = document.getElementById('arrows'), g = document.getElementById('grid');
       return s2.getAttribute('width') === String(g.offsetWidth);
     })()`) as unknown as boolean) === true,
    await q(`document.getElementById('arrows').getAttribute('width') + ' vs grid ' +
             document.getElementById('grid').offsetWidth`) as unknown as string)
  check('and it draws an edge per dependency the plan has',
    (await q(`document.querySelectorAll('#arrows path').length`) as unknown as number) > 0,
    `${await q(`document.querySelectorAll('#arrows path').length`)} paths`)

  // THE SUMMARY LINE AT EITHER END, here because it cannot be put back: work once recorded stays recorded
  // (ADR 0016), so finishing everything is undone by the reload into the big plan below and by nothing else.
  // NOTHING DONE — the line has nothing to add and must not be there.
  await send({ type: 'reopenTask', id: 't3' }); await settle()
  check('with nothing finished the line is absent rather than repeating the total',
    (await cardLines('Whole plan'))?.left === null,
    JSON.stringify(await cardLines('Whole plan')))
  // EVERYTHING DONE is the goal state and it arrives eventually. "0 left · 0
  // days" beside a total of eleven reads like something broken.
  for (let i = 0; i < 11; i++) await send({ type: 'finishTask', id: 't' + i, at: at(40) })
  await settle()
  check('and once everything is finished it says so in words, not "0 left"',
    (await cardLines('Whole plan'))?.left === 'all done',
    JSON.stringify(await cardLines('Whole plan')))

  // ---- THE SEARCH RUNS ON THE MACHINE READING THE PLAN ----------------------
  //
  // `suggestReorders` runs Sigma(lane^2) full schedules — 2,932 of them on this
  // fixture's shape. That did not get cheaper; it moved. Measured through the
  // same `/schedule.js`:
  //
  //     the server   23s   Fargate, Cpu: '256' — a quarter of one core
  //     a browser   1.8s
  //
  // The server was never slow because the function is slow. It is the smallest
  // container AWS sells, running against a machine that is sitting idle. So the
  // page computes it here, in a worker so nothing freezes, and the server route
  // stays as the fallback rather than the default.
  //
  // THE CHECK IS THAT THE SERVER IS NOT ASKED. That is the whole change, and it
  // is invisible from the chart — the panel looks identical either way.
  await mode('big=1')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length === ${BIG.tasks.length}`,
    'the plan the search is expensive on')
  // `:not(.busy)`, because the chip now appears WHILE the search runs — it says
  // "checking…" rather than nothing, which is right for a two-second wait and
  // wrong for a check that wants the answer. Waiting on the bare selector matches
  // the working chip instantly and reads a measurement that does not exist yet.
  await until(`!!document.querySelector('#msbar .ms.reord:not(.busy)')`, 'the Order chip to settle')
  const r0 = await reorderCalls()
  // DERIVED FROM THE FIXTURE, not typed in. A hardcoded row count is how a check
  // ends up asserting the shape of a plan nobody has any more.
  check('a plan this size is searched on this machine, and the server is not asked at all',
    r0 === 0 && (await q(`document.querySelectorAll('#grid .row').length`) as unknown as number) === BIG.tasks.length,
    `${r0} reorder request(s), ${await q(`document.querySelectorAll('#grid .row').length`)} of ${BIG.tasks.length} rows`)
  check('and the Order chip is showing its answer',
    (await q(`(() => { const c = document.querySelector('#msbar .ms.reord');
       return !!c && !c.classList.contains('stale'); })()`) as unknown as boolean) === true)

  // AND THE ADVICE NO LONGER ROTS. At 23 seconds an edit could only mark the
  // answer out of date and offer to check again — which meant the honest thing
  // to do was nothing, and the panel sat there describing a plan that had moved
  // on. At under three seconds the page just answers again.
  //
  // An edit that changes what the scheduler reads. BY `data-task`, not by label
  // text: "Task 7" is also a prefix of "Task 70" through "Task 79", and a fixture
  // big enough to be realistic is big enough for that to matter.
  const advice = () => q(`(() => {
    const c = document.querySelector('#msbar .ms.reord');
    return JSON.stringify(c ? { stale: c.classList.contains('stale'),
                                text: (c.querySelector('.vd') || {}).textContent || '' } : null);
  })()`) as unknown as Promise<string>
  // THROUGH `selectTask`, OR THE EDIT BELOW DOES NOT HAPPEN. One click leaves the
  // inspector folded, `#dur` is inside the collapsed region with a zero-sized
  // box, and `focus()` on it does not take — so `keyboard.type` typed into
  // nothing and `t7.dur` stayed at 1. Both this section and the slow-device one
  // below were therefore asserting against an edit that never landed, which is
  // why the fast one PASSED: "not stale" is also what doing nothing looks like.
  await selectTask('t7')
  await page.evaluate(`(() => { const d = document.querySelector('#insp #dur');
                                d.focus(); d.select(); })()`)
  await page.keyboard.type('9h')
  await page.evaluate(`document.querySelector('#insp #dur').blur()`)
  await until(`(() => { const c = document.querySelector('#msbar .ms.reord:not(.busy)');
     return !!c && !c.classList.contains('stale'); })()`, 'the advice to be recomputed after the edit', 20000)
  check('an edit gets a fresh answer rather than a note saying the old one is out of date',
    JSON.parse(await advice())?.stale === false, await advice())
  check('and it still did not ask the server',
    (await reorderCalls()) === r0, `${r0} -> ${await reorderCalls()} reorder request(s)`)

  // ---- THE SERVER IS STILL THERE, AND IS STILL THE ANSWER ON A DEVICE THAT
  //      CANNOT DO THIS ----------------------------------------------------
  //
  // Thirteen times slower than a current laptop is where the server starts
  // winning, and something has to catch the machines past that — along with a
  // browser too old for module workers, and a worker that dies. All three arrive
  // the same way: the local run rejects. Provoked by withholding the script.
  expect404 = /reorder-worker/
  await mode('noworker=1')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length === ${BIG.tasks.length}`, 'the plan without a worker')
  await until(`!!document.querySelector('#msbar .ms.reord:not(.busy)')`, 'the Order chip via the server')
  check('a page that cannot start the worker falls back to the server rather than going quiet',
    (await reorderCalls()) > r0, `${r0} -> ${await reorderCalls()} reorder request(s)`)
  check('and the answer it shows is the same shape, so the panel cannot tell which route ran',
    (await q(`document.querySelectorAll('#reorder-body .rsug, #msbar .ms.reord').length`) as unknown as number) > 0)
  await mode('noworker=0')
  expect404 = null

  // ---- A SLOW DEVICE KEEPS THE OLD BEHAVIOUR, AND THAT IS THE POINT OF
  //      MEASURING RATHER THAN PREDICTING ----------------------------------
  //
  // The page does not decide from the plan's size, it decides from how long the
  // search actually took HERE. So the only honest way to test the slow branch is
  // to be slow: Chrome's CPU throttle, which is the same instrument the device
  // numbers in `reorder-worker.ts` were measured with.
  //
  // CHROME'S CPU THROTTLE CANNOT DO THIS, which is worth recording because it is
  // the obvious tool and it silently does not work: at 4x the search still
  // finished in 1142ms — FASTER than the 1.8s it takes unthrottled on the main
  // thread, because a worker has a thread to itself. Two earlier versions of this
  // check passed for that reason while proving nothing.
  //
  // So the slowness is put where the stub can reach it: a `/schedule.js` whose
  // `suggestReorders` busy-waits 3.5s before doing the real work. That is a
  // device on which this takes 3.5s, which is exactly the condition the branch
  // turns on, and it is a busy-wait rather than a sleep because what the page
  // measures is elapsed time and what a slow phone spends is CPU.
  await mode('slowsearch=1')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length === ${BIG.tasks.length}`, 'the plan on a slow device')
  await until(`!!document.querySelector('#msbar .ms.reord:not(.busy)')`, 'the first answer on a slow device', 30000)
  // WHAT THIS DEVICE ACTUALLY TOOK, read off the chip rather than assumed from
  // the throttle. The bar's duration is this number, so it has to be in the DOM
  // anyway — which is what makes the branch observable instead of guessed at.
  const slowMs = Number(await q(`document.querySelector('#msbar .ms.reord').dataset.orderMs || 0`) as unknown as string)
  check('a slow device is measured, not guessed at — the chip carries what it cost here',
    slowMs > AUTO_MS_UNDER_TEST, `${slowMs}ms measured, threshold ${AUTO_MS_UNDER_TEST}ms`)
  const slowBefore = await reorderCalls()
  // Same reason as the section above: folded panel, no focus, no edit.
  await selectTask('t7')
  await page.evaluate(`(() => { const d = document.querySelector('#insp #dur');
                                d.focus(); d.select(); })()`)
  await page.keyboard.type('8h')
  await page.evaluate(`document.querySelector('#insp #dur').blur()`)
  await until(`!!document.querySelector('#msbar .ms.reord.stale')`,
    'the advice to be marked out of date on a slow device', 20000)
  check('a device that took too long marks the advice stale instead of chasing every edit',
    (await q(`document.querySelector('#msbar .ms.reord .vd').textContent`) as unknown as string) === 'out of date',
    await advice())
  // ASKED FOR, NOT AUTOMATIC — and still answered on this machine, not the
  // server. Slow is not the same as unable.
  //
  // GUARDED, because "Check again" only exists on a STALE chip. When the check
  // above fails there is no button, and a bare `.click()` on null threw a
  // puppeteer trace that took the whole run down — so one failing assertion
  // silently swallowed every check after it. This file already makes that
  // argument twice elsewhere ("OPTIONAL, so a regression upstream REPORTS rather
  // than stack-traces"); this was the site that had not learned it.
  const canCheckAgain = await q(`!!document.querySelector('#msbar .ms.reord .dt button')`) as unknown as boolean
  if (!canCheckAgain) {
    check('and "Check again" is what spends it, without falling back to the server', false,
      'no Check again button — the chip never went stale, see the failure above')
  } else {
    await page.evaluate(`document.querySelector('#msbar .ms.reord .dt button').click()`)
    await until(`!!document.querySelector('#msbar .ms.reord:not(.busy):not(.stale)')`, 'the recomputed advice', 30000)
    check('and "Check again" is what spends it, without falling back to the server',
      (await reorderCalls()) === slowBefore, `${slowBefore} -> ${await reorderCalls()} reorder request(s)`)
  }
  // BIG STAYS ON: the section below this one is the one that needs a real-shaped
  // plan, and it used to arrive already in that mode.
  await mode('slowsearch=0')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length === ${BIG.tasks.length}`,
    'the real-shaped plan back after the slow-device pass')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the small plan back')
  // ---- WHAT ONLY A REAL-SHAPED PLAN REACHES ---------------------------------
  //
  // Still on the 135-task fixture. Everything below is a code path the
  // eleven-task plan cannot get to: lanes long enough to need several tracks when
  // folded, tasks exempt from their queue, work with real start and finish dates,
  // and a dependency graph dense enough to draw arrows worth looking at.
  const shape = () => q(`JSON.stringify({
    heads: document.querySelectorAll('#grid .lane-head').length,
    rows: document.querySelectorAll('#grid .row').length,
    bars: document.querySelectorAll('#grid .row .bar').length,
    strips: document.querySelectorAll('#grid .baseline, #grid .elapsed').length,
    ticks: document.querySelectorAll('#grid .esttick').length,
    bands: document.querySelectorAll('#grid .band').length,
    cores: document.querySelectorAll('#grid .core').length,
    arrows: document.querySelectorAll('#arrows path').length,
  })`) as unknown as Promise<string>
  const big0 = JSON.parse(await shape())
  check('every task is drawn, on a head per lane',
    big0.rows === BIG.tasks.length && big0.bars === BIG.tasks.length
      && big0.heads === BIG.lanes.length, JSON.stringify(big0))
  check('work with a real start draws its elapsed strip',
    big0.strips > 0, `${big0.strips} strip(s)`)
  check('work that is finished draws the estimate it beat or missed',
    big0.ticks > 0, `${big0.ticks} estimate tick(s)`)
  check('a task carrying two systems draws bands, not a gradient',
    big0.bands > 0, `${big0.bands} band(s)`)
  check('a pointed shape puts its fill in an inset core',
    big0.cores > 0, `${big0.cores} core(s)`)
  check('the dependency graph draws arrows',
    big0.arrows > 0, `${big0.arrows} path(s)`)

  // THREE FOLD STATES WHERE THERE ARE THREE PICTURES. A lane whose work overlaps
  // has expanded -> one row per track -> one squeezed row; one whose work never
  // overlaps has nothing between the last two and cycles straight back. The small
  // fixture only ever had the second kind.
  const headOf = (n: number) => `document.querySelectorAll('#grid .lane-head')[${n}]`
  const rowsUnder = async (n: number) => await q(`(() => {
    let e = ${headOf(n)}.nextElementSibling, c = 0;
    while (e && !e.classList.contains('lane-head')) { if (e.classList.contains('row')) c++; e = e.nextElementSibling; }
    return c;
  })()`) as unknown as number
  const expanded = await rowsUnder(0)
  await page.evaluate(`${headOf(0)}.click()`); await settle()
  const perTrack = await rowsUnder(0)
  await page.evaluate(`${headOf(0)}.click()`); await settle()
  const squeezed = await rowsUnder(0)
  check('a long lane folds to one row per track, then to a single squeezed row',
    expanded > perTrack && perTrack > squeezed && squeezed === 1,
    `${expanded} -> ${perTrack} -> ${squeezed}`)
  check('and the squeezed rows are marked thin, which is what drops their grips',
    (await q(`document.querySelectorAll('#grid .row.thin').length`) as unknown as number) > 0)
  await page.evaluate(`${headOf(0)}.click()`); await settle()
  check('and unfolding puts every bar back on its own row',
    (await rowsUnder(0)) === expanded, `${await rowsUnder(0)} vs ${expanded}`)

  await fetch(`http://127.0.0.1:${PORT}/__mode?big=0`)

  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '))

  // ---- THE PLAN NAME, and the last `keep` -----------------------------------
  //
  // `#title` is a STABLE element — it was never rebuilt — and it still lost the
  // caret, for a different reason from the panels: `renderInner` assigned `.value`
  // on every render, and assigning a different string to a focused input moves the
  // caret to the end. So typing a plan name jumped to the end after every
  // character, and `emit(cmd, "#title")` put it back. Controlled, the assignment
  // only happens when the document actually differs from the box.
  await page.evaluate(`document.getElementById('renamebtn').click()`)
  await settle()
  check('the rename popover opens with the field focused and selected',
    (await q(`(() => { const t = document.getElementById('title');
       return !!t && document.activeElement === t; })()`) as unknown as boolean) === true)
  await page.evaluate(`(() => { const t = document.getElementById('title');
    t.focus(); t.setSelectionRange(4, 4); })()`)
  await page.keyboard.type('ZZ')
  await settle()
  check('typing mid-name keeps the caret, with nothing putting it back',
    (await q(`document.getElementById('title').selectionStart`) as unknown as number) === 6
      && (await q(`document.activeElement === document.getElementById('title')`) as unknown as boolean) === true,
    `caret ${await q(`document.getElementById('title').selectionStart`)} value ${await q(`JSON.stringify(document.getElementById('title').value)`)}`)
  check('and the name reaches the collapsed top bar',
    (await q(`document.getElementById('mini').textContent`) as unknown as string)
      .includes(await q(`document.getElementById('title').value`) as unknown as string))
  await page.keyboard.press('Escape')
  await settle()
  check('Escape closes the popover without clearing the selection',
    (await q(`document.getElementById('renamepop').hidden`) as unknown as boolean) === true)

  // ---- SCROLL SURVIVES A RENDER ---------------------------------------------
  //
  // `render()` saved `window.scrollY` and `#chart.scrollLeft` and put them back
  // by hand, and the comment on it records why: rebuilding every row shortened the
  // document for an instant, the browser CLAMPED scrollTop, and the clamp survived
  // — "clicking anything jumps me to the top". Reconciling does not shorten the
  // document, so the restore should be dead code. Nothing proved it either way,
  // which is how a workaround outlives the bug by years.
  // READ BACK WHAT THE BROWSER ACCEPTED, do not assume the number asked for. This
  // fixture's chart is narrow enough that `scrollLeft = 220` clamps to 15, and a
  // check that asserts 220 fails against correct behaviour — which is how a test
  // ends up "fixed" by loosening the thing it was meant to protect.
  const scrollNow = () => q(`(() => { const c = document.getElementById('chart');
     return JSON.stringify({ x: Math.round(c.scrollLeft), y: Math.round(window.scrollY) }); })()`) as unknown as Promise<string>
  await page.evaluate(`(() => {
    const c = document.getElementById('chart');
    c.scrollLeft = 220; window.scrollTo(0, 140);
  })()`)
  await settle()
  const scrolledTo = await scrollNow()
  // A command, so a real render runs — not a repaint of something already there.
  await page.evaluate(`document.querySelector('#grid .row .bar').click()`)
  await settle()
  check('a render leaves the chart where you scrolled it',
    (await scrollNow()) === scrolledTo, `${scrolledTo} -> ${await scrollNow()}`)
  await page.evaluate(`window.scrollTo(0, 0); document.getElementById('chart').scrollLeft = 0`)
  await settle()

  // ---- THE GRID'S VISUAL FINGERPRINT ----------------------------------------
  //
  // WHAT THIS IS FOR, because it is not another behaviour check. Every other check
  // in this file asks whether the chart DOES the right thing. The chart's whole
  // vocabulary is visual, and the four things in the row loop that have each been
  // got wrong once already are things it LOOKS like:
  //
  //   * a pointed shape paints its rim on `.shape` and its fill on an inset
  //     `.core`, because a CSS border would be painted on the box edges and then
  //     clipped away by the silhouette
  //   * several colours are real `.band` elements, not a `linear-gradient`, because
  //     a gradient lives in `background-image` — where the confidence hatch lives
  //   * the fill is assigned with `backgroundColor`, not the `background`
  //     shorthand, which resets `background-image` and erases that hatch
  //   * the estimate is a tick with a whisker, not a ghost bar
  //
  // Counts and `left` cannot see any of that. Computed style can, and unlike a
  // screenshot it is deterministic, diffable and says WHICH property moved.
  //
  // Written with --fingerprint, compared on every other run. A mismatch is not
  // automatically a bug — it is "the chart draws differently than it did", which
  // is exactly the sentence a rewrite of this loop needs someone to read.
  // PAINT, NOT GEOMETRY, and the distinction is forced rather than chosen. The
  // first version of this list carried `left`/`top`/`width`/`height` and passed on
  // a laptop and failed in CI on the same commit: `left: 1072.98px` against
  // `1079.74px`. The label column's width is MEASURED from text with canvas
  // `measureText`, so every pixel on this chart is downstream of font metrics, and
  // those differ between macOS and Linux. A golden that encodes them is a golden
  // that can only ever be right on the machine that wrote it.
  //
  // Nothing this file exists for is lost. The four things it is here to protect —
  // the pointed shape's rim/core split, bands rather than a gradient, the hatch
  // surviving in `background-image`, and the estimate tick — are all paint. Layout
  // is covered by checks that compare against THEMSELVES rather than a stored
  // number: rows ordered by start, a drag changing the width it should, the row
  // and bar counts in all three modes, and the arrow layer sized to the grid.
  const PROPS = ['background-color', 'background-image', 'border-top', 'border-right',
                 'border-bottom', 'border-left', 'border-radius', 'clip-path', 'opacity']
  const fingerprint = async () => await page.evaluate(`(() => {
    const props = ${JSON.stringify(PROPS)};
    const styleOf = el => { const cs = getComputedStyle(el); const o = {};
      for (const p of props) o[p] = cs.getPropertyValue(p); return o; };
    const rows = [...document.querySelectorAll('#grid .row')];
    return rows.map(r => ({
      label: (r.querySelector('.rowlabel')?.textContent || '').trim(),
      cls: r.className,
      bars: [...r.querySelectorAll('.bar')].map(b => ({
        cls: b.className,
        self: styleOf(b),
        parts: [...b.querySelectorAll('.shape, .core, .band, .grip, .esttick, .estlead, .eyemark')]
          .map(e => ({ cls: e.className, style: styleOf(e) })),
      })),
      strips: [...r.querySelectorAll('.baseline, .elapsed')].map(e => ({ cls: e.className, style: styleOf(e) })),
    }));
  })()`) as unknown as unknown[]

  // A CLEAN CHART, not the one 90 checks have been editing. Reload, wait for the
  // plan, and fingerprint the three shapes the row loop can be in.
  await reloadPage()
  await settle()
  const shots: Record<string, unknown> = {}
  shots.team = await fingerprint()

  // WORK SESSIONS DRAW AS SESSIONS. An unstarted task is given two and is unfinished: one segment
  // each, then the forecast from now. Put back straight after (by a reload), so the fingerprints below are of the
  // clean chart. And the axis is pinned, so the dates stay in view while the rows scroll under it.
  await relay({ type: 'setSessions', id: 't2', sessions: [
    { start: '2026-01-08T09:00:00Z', stop: '2026-01-08T11:00:00Z' },
    { start: '2026-01-09T09:00:00Z', stop: '2026-01-09T10:00:00Z' }] })
  await settle()
  const wsegs = await q(`(() => { const b = document.querySelector('#grid .row[data-task="t2"] .bar');
    return b ? [...b.querySelectorAll('.wseg')].map(e => e.className) : null })()`) as unknown as string[] | null
  // Sessions cannot be taken back (ADR 0016); the stub stores nothing, so a reload is the clean chart again.
  await reloadPage()
  await settle()
  check('a worked task draws a segment per session and its forecast as work chunks',
    JSON.stringify(wsegs) === JSON.stringify(['wseg', 'wseg', 'wseg fc']), JSON.stringify(wsegs))
  check('the date axis stays pinned while the rows scroll',
    await q(`getComputedStyle(document.querySelector('#axis')).position`) === 'sticky')
  await page.evaluate(`document.querySelector('#grid .lane-head.fold')?.click()`)
  await settle()
  shots.folded = await fingerprint()
  await page.evaluate(`document.querySelector('#grid .lane-head.fold')?.click()`)
  await settle()
  await setNative('#rowmode', 'date', 'HTMLSelectElement')
  await settle()
  shots.date = await fingerprint()
  await setNative('#rowmode', 'team', 'HTMLSelectElement')
  await settle()

  const GOLDEN = join(import.meta.dir, 'grid-fingerprint.json')
  const now = JSON.stringify(shots, null, 1)
  if (process.argv.includes('--fingerprint')) {
    await Bun.write(GOLDEN, now + '\n')
    console.log(`\nwrote ${GOLDEN} (${Object.keys(shots).length} modes, ${now.length} bytes)`)
  } else if (existsSync(GOLDEN)) {
    const want = (await Bun.file(GOLDEN).text()).trim()
    if (want === now) {
      check('the grid draws exactly as the golden fingerprint says it should',
        true, `${now.length} bytes across ${Object.keys(shots).length} modes`)
    } else {
      // Say WHERE, not just that. A 200KB diff nobody can read is a failure that
      // gets deleted rather than investigated.
      const a = JSON.parse(want) as any, bb = shots as any
      const where: string[] = []
      for (const mode of Object.keys(bb)) {
        const A = JSON.stringify(a[mode]), B = JSON.stringify(bb[mode])
        if (A !== B) {
          let i = 0; while (i < A.length && i < B.length && A[i] === B[i]) i++
          where.push(`${mode} differs from char ${i}: golden …${A.slice(Math.max(0,i-60), i+60)}… vs now …${B.slice(Math.max(0,i-60), i+60)}…`)
        }
      }
      check('the grid draws exactly as the golden fingerprint says it should',
        false, where.join('  |  ').slice(0, 700))
    }
  } else {
    console.log('  --   no grid-fingerprint.json yet; run with --fingerprint to write one')
  }

  // ---- WHO ELSE IS HERE, AND WHERE THEY ARE POINTING ------------------------
  //
  // `ui/Presence.tsx` was the only ported region with no checks at all, and it is
  // the worst place to have none: a broken roster and an empty room render
  // identically, so this is the one thing that stays broken because it looks
  // fine. Everything below arrives as frames on the page's own socket — see
  // `/__peer` in the stub for why that is the whole of being a peer.
  //
  // Deliberately AFTER the fingerprint, on the reloaded page: a clean chart, the
  // small plan, and nothing left over from ninety checks of editing it.
  const errsBefore = errs.length
  check('alone in the room, the roster is just you',
    (await chips()).length === 1 && (await chips())[0].mine === true,
    JSON.stringify(await chips()))

  // THEIR COORDINATES, OUR PIXELS — put their pointer on the milestone rule,
  // which is the one line on this chart whose day both halves of the page can
  // name. `.gl.deadline` is placed at `X(dayOf(m.date))` by the imperative
  // renderer; the pointer is placed at `LABW + (day - LO) * PPD` by React. Same
  // day in, same pixel out. If those ever diverge a colleague's pointer sits
  // confidently over the wrong task, which is worse than not drawing it — and it
  // is invisible from your own screen, because your own cursor is drawn locally.
  const MS_DAY = (Date.parse(LIVE.milestones[0]!.date) - Date.parse(LIVE.start)) / 86400000
  const ADA = `id=s2&name=Ada&color=%23ff00aa&day=${MS_DAY}`
  await peer(`${ADA}&row=0`); await settle()
  const roster = await chips()
  check('a peer arriving gets a roster chip, and it is not yours',
    roster.length === 2 && roster[1].name === 'Ada' && roster[1].mine === false,
    JSON.stringify(roster))
  const ada = (await pointers())[0]
  check('and a pointer on the chart, in their name and their colour',
    (await pointers()).length === 1 && ada?.name === 'Ada' && ada?.color === 'rgb(255, 0, 170)',
    JSON.stringify(await pointers()))
  const ruleLeft = await q(`parseFloat(document.querySelector('#grid .gl.deadline').style.left)`) as unknown as number
  check('their chart day lands on our pixel, to the milestone rule',
    Math.abs(ada.left - ruleLeft) < 0.5, `pointer at ${ada.left}, rule at ${ruleLeft}, day ${MS_DAY}`)

  // The vertical half of the same conversion, against the chart's own row rather
  // than against 26 written down twice.
  await peer(`${ADA}&row=1`); await settle()
  const rowH = await q(`document.querySelector('#grid .row').getBoundingClientRect().height`) as unknown as number
  const dropped = (await pointers())[0].top - ada.top
  check('and one row down is exactly one row down', dropped === rowH, `${dropped}px vs a row of ${rowH}px`)

  // Nothing verifies a name and nothing requires one, so the page needs an answer
  // for a peer who sent neither it nor a colour.
  await peer('id=s3'); await settle()
  check('a peer who sent no name is still somebody',
    (await chips())[2]?.name === 'someone' && (await pointers()).length === 1,
    JSON.stringify(await chips()))

  // THE LAYER IS CREATED ONCE AND THEN BELONGS TO REACT. `renderInner` clears the
  // grid BY SELECTOR, so `#cursors` is not swept up with the rows — a peer's
  // pointer is reconciled through somebody else's edit instead of being torn down
  // and rebuilt twenty times a second.
  //
  // MARKED, NOT COUNTED, and that is a correction worth recording: the first
  // version of this check asserted only that a pointer was still on screen after
  // the render, and it PASSED with `#cursors` added to that remove-by-selector
  // list. It could not fail. `drawPresence()` runs after every render, so the
  // layer is rebuilt and the pointer redrawn within the same tick, and the two
  // mechanisms cover for each other exactly well enough to hide either one
  // breaking. The tag is on the NODE, so only survival can keep it.
  await page.evaluate(`document.getElementById('cursors').dataset.tag = 'kept'`)
  await fetch(`http://127.0.0.1:${PORT}/api/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: { type: 'renameTask', id: 't0', label: 'Renamed by the room' } }) })
  await settle()
  check('a render caused by somebody else reconciles the pointers rather than rebuilding them',
    (await pointers()).length === 1
      && (await q(`document.getElementById('cursors').dataset.tag`) as unknown as string) === 'kept',
    `${(await pointers()).length} pointers, layer tag ${await q(`JSON.stringify(document.getElementById('cursors').dataset.tag)`)}`)

  // THE GRAPH LENS HAS NO DAY AXIS, so a chart coordinate has nowhere to land on
  // it. Drawn anyway, five pointers pile into the top-left corner over a force
  // layout and call themselves multiplayer. The guard is in `drawCursors`, so
  // what proves it is a cursor ARRIVING while the lens is up, not the switch.
  await setNative('#view', 'graph', 'HTMLSelectElement'); await settle()
  await peer(`${ADA}&row=2`); await settle()
  check('a cursor arriving while the graph lens is up draws nothing',
    (await pointers()).length === 0, JSON.stringify(await pointers()))
  await setNative('#view', 'timeline', 'HTMLSelectElement'); await settle()
  check('and the timeline draws them again, where they now are',
    (await pointers()).length === 1 && (await pointers())[0].top === ada.top + 2 * rowH,
    JSON.stringify(await pointers()))

  await peer('id=s2&left=1'); await peer('id=s3&left=1'); await settle()
  check('leaving takes the chip and the pointer with it',
    (await chips()).length === 1 && (await pointers()).length === 0,
    `${(await chips()).length} chips, ${(await pointers()).length} pointers`)
  check('and none of the presence pass logged a page error',
    errs.length === errsBefore, errs.slice(errsBefore, errsBefore + 3).join(' | '))

  // ---- DRAWING A DEPENDENCY, AND REFUSING TO CLOSE A CYCLE -------------------
  //
  // THE ASYMMETRY IS THE POINT. `invalid()` on the server deliberately does not
  // look for cycles — that would be a second copy of the scheduler on the far
  // side of the wire, which is the thing ADR 0001 exists to prevent. So the page
  // is the ONLY cycle handling in this tool, it runs on a throwaway clone BEFORE
  // the command is emitted, and a command that got past it would be accepted,
  // broadcast, and turn every connected chart into the "⚠" verdict at once.
  //
  // Which means counting is not enough. The refusal has to be checked by what
  // went on the WIRE, because "the chart looks the same" is also what you see
  // when a cycle was sent and every other tab is the one that broke.
  const sent = async () => ((await probe()) as { wire: { type: string; id: string; dep: string }[] }).wire
  const arrows = () => q(`document.querySelectorAll('#arrows path').length`) as unknown as Promise<number>
  const link = async (from: string, to: string) => {
    await page.evaluate(`${rowOf2(from)}.querySelector('.bar').click()`); await settle()
    // THE PANEL'S BUTTON, not the toolbar's — `#link` was deleted on 2026-09-20
    // in favour of the two named ones, and `#mklink` is the same "blocks"
    // direction it armed.
    await page.evaluate(`document.querySelector('#insp #mklink').click()`); await settle()
    const armed = await q(`document.getElementById('insp').textContent`) as unknown as string
    await page.evaluate(`${rowOf2(to)}.querySelector('.bar').click()`); await settle()
    return armed
  }

  // t1 has no dependants, so t2 waiting for it closes nothing.
  const beforeLink = (await sent()).length, arrowsBefore = await arrows()
  const armed = await link('t1', 't2')
  // THE TOOLBAR BUTTON ARMS THE "BLOCKS" DIRECTION, and the banner now names the
  // CLICK it wants rather than the mode it is in — "Linking from Task 1" until
  // 2026-09-20, when a second direction made that sentence ambiguous. The
  // assertion is the same claim either way: you can tell which task is armed.
  check('arming the link tells you which task you are linking FROM',
    armed.includes('must wait for') && armed.includes('Task 1'), armed.replace(/\s+/g, ' ').slice(0, 90))
  const linked = (await sent()).slice(beforeLink)
  check('and clicking the task that must wait sends exactly one addDep',
    linked.length === 1 && linked[0]?.type === 'addDep'
      && linked[0]?.id === 't2' && linked[0]?.dep === 't1',
    JSON.stringify(linked))
  check('and the arrow it drew is on the chart',
    (await arrows()) === arrowsBefore + 1, `${arrowsBefore} -> ${await arrows()} paths`)

  // t0 -> t2 -> t4 is already in the fixture, so t0 waiting for t4 closes the
  // loop. It has to be a pair with no arrow between them YET: `addDep` is
  // idempotent by design, and the `includes` guard in front of the cycle check
  // means a task that already waits for its target never reaches it. Asking t4
  // to wait for t2 looks like a cycle, sends nothing, and prints nothing — which
  // is indistinguishable from the refusal firing, and passed three of these four
  // checks while proving none of them.
  //
  // The refusal runs on a clone, so the chart must not move either.
  await page.evaluate(`document.getElementById('msg').textContent = ''`)
  const beforeCycle = (await sent()).length, arrowsCycle = await arrows()
  await link('t4', 't0')
  check('a link that would close a cycle says so, in the words the page prints',
    (await msg()).includes('That would create a cycle'), JSON.stringify(await msg()))
  check('and NOTHING went on the wire, because the server would have taken it',
    (await sent()).length === beforeCycle, JSON.stringify((await sent()).slice(beforeCycle)))
  check('and the throwaway copy it was tried on left the chart alone',
    (await arrows()) === arrowsCycle, `${arrowsCycle} -> ${await arrows()} paths`)

  // ---- REVERT, WHICH IS THE ROOM'S UNDO AND NOT YOURS -----------------------
  //
  // `/api/revert` is the one history operation that CHANGES the room: it
  // discards the live draft for everyone looking at the plan and puts an
  // archived version in its place. So it names what it is throwing away and who
  // did it before it asks, and the question itself is part of the feature — a
  // confirm that stopped being asked would be the whole regression.
  const labelOf = (id: string) => q(`${rowOf2(id)}.querySelector('.rowlabel').textContent.trim()`) as unknown as Promise<string>
  const post = (cmd: unknown) => fetch(`http://127.0.0.1:${PORT}/api/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })

  await post({ type: 'renameTask', id: 't1', label: 'Something unsaved' }); await settle()
  check('a change from the room is on the chart, and it is unsaved',
    (await labelOf('t1')) === 'Something unsaved', await labelOf('t1'))
  const askedBefore = dialogs, revertsBefore = await reverts()
  await page.evaluate(`document.getElementById('msg').textContent = ''`)
  await page.evaluate(`document.getElementById('revert').click()`)
  await settle()
  check('reverting asks before it discards anybody else’s work', dialogs === askedBefore + 1,
    `${dialogs - askedBefore} question(s) asked`)
  check('and the plan goes back to the saved version, for the whole room',
    (await reverts()) === revertsBefore + 1
      && (await labelOf('t1')) === 'Task 1'
      && (await msg()).includes('reverted this plan to save #6'),
    `t1 is "${await labelOf('t1')}", flash ${JSON.stringify(await msg())}`)

  // ---- EXECUTING A SWAP -----------------------------------------------------
  //
  // THE ONE OPERATION THAT WILL NOT GO DOWN THE SOCKET. A swap replaces both
  // channels' value lists AND repoints every task at the new ids, and there is no
  // order in which those are separate commands: the server runs `invalid()` after
  // each one, so lists-first orphans every task and tasks-first names ids that do
  // not exist yet. Either way the FIRST command is rejected and nothing happens.
  // It goes as one all-or-nothing batch over HTTP, and the chart moves when the
  // frames come back — there is no optimistic apply, because an HTTP command
  // carries no session ref and the server broadcasts it to the sender too.
  //
  // The panel was covered; pressing the button was not. Colours and fills both
  // hold two values on this fixture, so a count proves nothing — what has to move
  // is the LABELS, from one channel's list into the other's.
  //
  // The LABELS, read off the value rows' own inputs. A chit's `textContent` is
  // its usage count and its buttons — which do not swap cleanly and should not:
  // colours are a list channel and fills are not, so a multi-colour task loses
  // its extras on the way across. That is documented behaviour, and reading it
  // as the assertion would have made this check fail for being right.
  const chits = (ch: string) => q(`JSON.stringify([...document.querySelectorAll('#ch-${ch} .chit input.cl')]
    .map(e => e.value))`) as unknown as Promise<string>
  await page.evaluate(`document.getElementById('cog').click()`); await settle()
  await page.evaluate(`document.querySelector('#settings [data-tab="swap"]').click()`); await settle()
  const colorsWere = await chits('colors'), fillsWere = await chits('fills')
  await setNative('#swapa', 'colors', 'HTMLSelectElement')
  await setNative('#swapb', 'fills', 'HTMLSelectElement')
  await settle()
  const swapAsked = dialogs, postedBefore = ((await probe()) as { posted: unknown[] }).posted.length
  await page.evaluate(`document.getElementById('swapgo').click()`)
  await settle()
  check('swapping two channels asks first, because there is no undo for it',
    dialogs === swapAsked + 1, `${dialogs - swapAsked} question(s) asked`)
  const batch = ((await probe()) as { posted: { type: string }[] }).posted.slice(postedBefore)
  check('and it goes as ONE batch: the lists, then every task repointed',
    batch.length === 1 + 2 * 11 && batch[0]?.type === 'patchDoc'
      && batch.slice(1).every(c => c.type === 'setTaskColors' || c.type === 'setTaskChannel'),
    `${batch.length} commands, first ${batch[0]?.type}`)
  await page.evaluate(`document.getElementById('set-close').click()`); await settle()
  check('and the two channels have each other’s values afterwards',
    (await chits('colors')) === fillsWere && (await chits('fills')) === colorsWere,
    `colors ${colorsWere} -> ${await chits('colors')}, fills ${fillsWere} -> ${await chits('fills')}`)

  // ---- SIX DROPDOWNS BUILT FROM THE PLAN ------------------------------------
  //
  // These were the last `<select>`s assembling `<option>` markup as a string, and
  // ADR 0004 kept them out on the grounds that React would own the options while
  // the markup owned the element the change fires on. It owns the whole control
  // now. `#zoom`, `#swapa` and `#swapb` are already driven by checks above; these
  // three were not, and rewriting untested code is the mistake the banners just
  // taught — twice in one session is a habit.
  //
  // THE HOST DRAWS NO BOX, which is the whole reason the toolbar did not move:
  // React needs an element to render into, and `display:contents` is a container
  // that generates none. If that ever stops being true, every one of these labels
  // silently gains a layout box.
  await page.evaluate(`document.getElementById('cog').click()`); await settle()
  await page.evaluate(`document.querySelector('#settings [data-tab="arrows"]').click()`); await settle()
  check('every dropdown built from the plan is a real select inside a host that draws no box',
    (await q(`JSON.stringify(['zoom','swapa','swapb','dhover','dclick','ggroup'].map(id => {
       const s = document.getElementById(id), h = document.getElementById(id + 'host');
       return [id, !!s && s.tagName === 'SELECT' && s.parentElement === h,
               h ? getComputedStyle(h).display : 'no host'];
     }))`) as unknown as string) ===
    JSON.stringify(['zoom','swapa','swapb','dhover','dclick','ggroup'].map(id => [id, true, 'contents'])),
    await q(`JSON.stringify(['zoom','swapa','swapb','dhover','dclick','ggroup'].map(id => {
       const s = document.getElementById(id), h = document.getElementById(id + 'host');
       return [id, !!s && s.tagName === 'SELECT' && s.parentElement === h,
               h ? getComputedStyle(h).display : 'no host'];
     }))`) as unknown as string)

  // A CONTROLLED SELECT SHOWS THE DOCUMENT, not whatever it was last left on.
  //
  // PROVED FROM THE ROOM, not from the click. Asserting that the dropdown shows
  // what you just picked proves nothing at all — an UNCONTROLLED select does that
  // too, by simply keeping what the browser put there. Swapping `value` for
  // `defaultValue` passed this check in its first form. So the second half of it
  // changes `depth` from somebody else's tab and asks whether the control
  // followed, which only a value driven by the document can do.
  const chainDepth = () => q(`document.getElementById('dhover').value`) as unknown as Promise<string>
  const depthWas = await chainDepth()
  await setNative('#dhover', 'all', 'HTMLSelectElement')
  await settle()
  const wire2 = (await sent()).slice(-1)[0] as { type: string; patch?: { depth?: Record<string, unknown> } }
  check('picking a chain depth is what sends it',
    wire2?.type === 'patchDoc' && wire2?.patch?.depth?.hover === 'all',
    `was ${depthWas}, sent ${JSON.stringify(wire2)}`)
  await post({ type: 'patchDoc', patch: { depth: { hover: 2, click: 'all' } } })
  await until(`document.getElementById('dhover').value === '2'`, 'the dropdown to follow the document')
  check('and it shows what the PLAN says, not what this tab last clicked',
    (await chainDepth()) === '2', `${await chainDepth()} after the room set it to 2`)

  // GROUPING NEEDS SOMETHING TO GROUP BY. A channel with under two values cannot
  // separate anything, which is the same rule the legend and the inspector apply.
  await page.evaluate(`document.getElementById('set-close').click()`); await settle()
  await setNative('#view', 'graph', 'HTMLSelectElement')
  await until(`!!document.getElementById('ggroup')`, 'the graph grouping dropdown')
  check('the grouping dropdown offers nothing, plus every channel that can group',
    (await q(`JSON.stringify([...document.querySelectorAll('#ggroup option')].map(o => o.value))`) as unknown as string)
      === JSON.stringify(['', 'lanes', 'colors', 'borders', 'fills', 'shapes']),
    await q(`JSON.stringify([...document.querySelectorAll('#ggroup option')].map(o => o.textContent))`) as unknown as string)
  // AND ITS LABELS COME FROM THE DOCUMENT. Renaming a channel from the room has
  // to reach the list, or it is a hardcoded menu that happens to look right.
  //
  // The rule this list also applies — a channel with under two values cannot
  // group anything — is NOT exercised, and cannot be on this fixture: every
  // channel in it holds exactly two. Deleting the filter passes this check.
  await post({ type: 'patchDoc', patch: { channelLabels: { lanes: 'Squad', colors: 'System',
                borders: 'Env', fills: 'Accuracy' } } })
  await until(`[...document.querySelectorAll('#ggroup option')].some(o => o.textContent === 'Squad')`,
    'the renamed channel to reach the grouping list')
  check('and its labels are the plan’s, not a menu that happens to look right',
    (await q(`JSON.stringify([...document.querySelectorAll('#ggroup option')].map(o => o.textContent))`) as unknown as string)
      === JSON.stringify(['Nothing', 'Squad', 'System', 'Env', 'Accuracy', 'Shape']),
    await q(`JSON.stringify([...document.querySelectorAll('#ggroup option')].map(o => o.textContent))`) as unknown as string)
  await setNative('#view', 'timeline', 'HTMLSelectElement'); await settle()

  // ---- IMPORT, EXPORT, AND THE PICTURE ---------------------------------------
  //
  // The import path CREATES PLANS, which is why nothing had ever driven it: a
  // check that ran against a real server would leave plans nobody can reach
  // behind it, and nothing lists plans to go and find them. Against the stub it
  // costs nothing — `/api/plan/new` records what it was asked for and stores
  // none of it.
  //
  // A BUNDLE OF TWO, deliberately. One plan navigates straight to it, which ends
  // the run; two or more shows the summary banner instead — and that banner is
  // the only time those tokens are ever displayed, so a reader who closes the tab
  // without copying them has made plans nobody can open.
  const bundle = '/tmp/harness-import-bundle.json'
  await Bun.write(bundle, JSON.stringify({ plans: {
    alpha: { ...LIVE, title: 'Imported alpha' },
    beta:  { ...LIVE, title: 'Imported beta' },
  } }))
  const createsBefore = ((await probe()) as { creates: number }).creates
  await (await page.$('#importfile'))!.uploadFile(bundle)
  await until(`!!document.getElementById('importsummary')`, 'the import summary banner')
  const madeFor = ((await probe()) as { created: string[] }).created.slice(createsBefore)
  check('importing a bundle makes one NEW plan per entry, under its own title',
    madeFor.length === 2 && madeFor.includes('Imported alpha') && madeFor.includes('Imported beta'),
    JSON.stringify(madeFor))
  check('and the summary hands back every link, because nothing else ever will',
    (await q(`document.querySelectorAll('#importsummary a[href^="#"]').length`) as unknown as number) === 2
      && (await q(`document.getElementById('importsummary').textContent`) as unknown as string)
           .includes('the only way back to them'),
    await q(`JSON.stringify([...document.querySelectorAll('#importsummary a')].map(a => a.textContent))`) as unknown as string)
  await page.evaluate(`document.getElementById('importsummary').remove()`)

  // A FILE THAT IS NOT A PLAN says so and creates nothing. The refusal matters
  // more than the success: this is the one control that mints plans.
  const junk = '/tmp/harness-import-junk.json'
  await Bun.write(junk, 'not json at all {')
  await page.evaluate(`document.getElementById('msg').textContent = ''`)
  const createsAfter = ((await probe()) as { creates: number }).creates
  await (await page.$('#importfile'))!.uploadFile(junk)
  await until(`document.getElementById('msg').textContent.length > 0`, 'the refusal')
  check('a file that is not JSON is refused, and mints nothing',
    (await msg()).includes('not JSON')
      && ((await probe()) as { creates: number }).creates === createsAfter,
    `${JSON.stringify(await msg())}, ${((await probe()) as { creates: number }).creates - createsAfter} plan(s) created`)

  // EXPORT CARRIES THE ARCHIVE. A backup that quietly drops every version is a
  // backup of the present, which is not what anybody means by one.
  await page.evaluate(`document.getElementById('msg').textContent = ''`)
  await page.evaluate(`document.getElementById('exportone').click()`)
  await until(`document.getElementById('msg').textContent.includes('exported')`, 'the export to report')
  check('exporting one plan writes it with its history, and says how many versions',
    /exported harness\.json with 6 versions/.test(await msg()), JSON.stringify(await msg()))

  // THE PICTURE, AND WHAT IT DOES WHEN IT CANNOT DRAW ONE. The library comes off
  // the network the first time the button is pressed; a failure has to reach the
  // bar rather than take the plan down with it, and rather than look like a
  // button that does nothing.
  await page.setRequestInterception(true)
  const killShot = (r: { url(): string; abort(): unknown; continue(): unknown }) =>
    r.url().includes('html-to-image') ? r.abort() : r.continue()
  page.on('request', killShot)
  await page.evaluate(`document.getElementById('msg').textContent = ''`)
  await page.evaluate(`document.getElementById('shot').click()`)
  await until(`document.getElementById('msg').textContent.length > 0`, 'the screenshot to report')
  check('a screenshot whose library will not load says so in the bar, and leaves the plan up',
    (await msg()) === 'could not make an image: the image library could not be loaded',
    JSON.stringify(await msg()))
  check('and the chart is still there afterwards',
    (await rows()) === 11, `${await rows()} rows`)
  page.off('request', killShot)
  await page.setRequestInterception(false)

  // ---- RENAMING A TASK OTHER TASKS TALK ABOUT -------------------------------
  //
  // A name is not only a name: it turns up in other tasks' names and notes, and a
  // rename leaves every one of those saying something that is no longer true.
  // The dialog offers to fix them, in ONE batch, so it is one History entry
  // rather than nine edits landing one at a time in front of the room.
  //
  // "Task 1" is a prefix of "Task 10", which is what makes this drivable on the
  // fixture — and is also the trap the panel exists to make visible rather than
  // guess at.
  await page.evaluate(`${rowOf2('t1')}.querySelector('.bar').click()`); await settle()
  await page.evaluate(`document.getElementById('lab').focus()`)
  await setNative('#insp #lab', 'Kickoff')
  await page.evaluate(`document.getElementById('lab').blur()`)
  await until(`!document.getElementById('mentions').hidden`, 'the mentions dialog')
  check('renaming a task offers to update the tasks that mention it, ticked by default',
    (await q(`document.querySelectorAll('#mentions-list [data-m]').length`) as unknown as number) === 1
      && (await q(`document.querySelectorAll('#mentions-list input:checked').length`) as unknown as number) === 1
      && (await q(`document.getElementById('mentions-apply').textContent`) as unknown as string) === 'Update 1 mention',
    `${await q(`document.querySelectorAll('#mentions-list [data-m]').length`)} hit(s), `
      + `button "${await q(`document.getElementById('mentions-apply').textContent`)}"`)
  // NOTHING ANYBODY TYPED IS INTERPOLATED INTO MARKUP. The component splits the
  // old name out and puts the marks BETWEEN the pieces, which is what the old
  // "escape first, then split on the escaped needle" dance was buying.
  // NULL-SAFE, like the drag checks. A bare `.textContent` on a missing element
  // throws a puppeteer trace and takes the whole run with it instead of naming
  // the check — which is what happened the first time this was broken on purpose.
  const diffMarks = () => q(`JSON.stringify(['del', 'ins']
    .map(t => (document.querySelector('#mentions-list ' + t) || {}).textContent || null))`) as unknown as Promise<string>
  check('and it shows the old name struck through with the new one beside it',
    (await diffMarks()) === JSON.stringify(['Task 1', 'Kickoff']), await diffMarks())
  const beforeMentions = ((await probe()) as { posted: { type: string; id: string; label?: string }[] }).posted.length
  await page.evaluate(`document.getElementById('mentions-apply').click()`)
  await until(`document.getElementById('mentions').hidden`, 'the dialog to close on apply')
  await settle()
  const mentionBatch = ((await probe()) as { posted: { type: string; id: string; label?: string }[] }).posted.slice(beforeMentions)
  check('applying sends ONE batch that renames the mention, not nine separate edits',
    mentionBatch.length === 1 && mentionBatch[0]?.type === 'renameTask'
      && mentionBatch[0]?.id === 't10' && mentionBatch[0]?.label === 'Kickoff0',
    JSON.stringify(mentionBatch))
  check('and the chart shows the updated name',
    (await labelOf('t10')) === 'Kickoff0', await labelOf('t10'))

  // ---- THE KEYRING, AND THE HALF OF A LINK THAT IS NOT ON THE PLAN ----------
  //
  // A task carries a `ref` — its id in whatever tracker the team uses. The BASE
  // URL is not on the document and cannot be put there: it is not in
  // `PATCHABLE_DOC_KEYS`, so `patchDoc` refuses it, and it lives per plan in each
  // viewer's own browser. That split is the whole point — a plan carrying 135
  // refs still does not say whose tracker they belong to.
  await post({ type: 'setTaskRef', id: 't3', ref: '1234' })
  await settle()
  await page.evaluate(`document.getElementById('cog').click()`); await settle()
  await page.evaluate(`document.querySelector('#settings [data-tab="links"]').click()`); await settle()
  const beforeBase = (await sent()).length
  const postedBeforeBase = ((await probe()) as { posted: unknown[] }).posted.length
  await setNative('#refbase', 'https://example.com/tickets/{ref}')
  await settle()
  check('a link base interpolates a real ref from this plan, so the sample is the shape in use',
    (await q(`document.getElementById('krsample').textContent`) as unknown as string)
      .includes('https://example.com/tickets/1234'),
    (await q(`document.getElementById('krsample').textContent`) as unknown as string).replace(/\s+/g, ' ').slice(0, 70))
  check('and the base goes nowhere near the plan — nothing was sent, and the doc still holds only the ref',
    (await sent()).length === beforeBase
      && ((await probe()) as { posted: unknown[] }).posted.length === postedBeforeBase,
    `${(await sent()).length - beforeBase} command(s) sent by typing a link base`)
  await page.evaluate(`document.getElementById('set-close').click()`); await settle()

  // ---- A CHANNEL WITH ONE VALUE CANNOT GROUP ANYTHING -----------------------
  //
  // `#ggroup` drops channels holding fewer than two values, and nothing proved
  // it: every channel in this fixture holds exactly TWO, so deleting the filter
  // passed the whole suite. A rule you cannot violate is not under test.
  //
  // Made violable with real commands rather than a second fixture — tasks off the
  // value first, then the list, which is the order the channel editor uses and
  // the only one that leaves the document valid at every step.
  //
  // `post` returns when the STUB has the command, which says nothing about the
  // PAGE having applied it — those frames arrive over the socket afterwards. The
  // wait here used to be for `#ggroup` to EXIST, which the graph view provides
  // whether or not the patch has landed, so the options were read off a document
  // that still held two shapes. That is why this check failed four of eight CI
  // runs over a week while passing on every laptop: the runner is slower, not
  // different. Wait for the three commands to actually reach the page.
  //
  // Counted off the unsaved tally (`sockSeq - savedSeq`), which is a DELIVERY
  // signal and deliberately not the >= 2 rule being asserted — waiting on the
  // rule itself would leave a check that cannot fail, which is the thing this
  // block was written to stop being.
  // TWO WAITS, BECAUSE THERE ARE TWO LAGS, AND NEITHER IS `#ggroup` EXISTING.
  //
  // This check failed four CI runs between 2026-09-11 and 2026-09-18 and passed
  // on every laptop. (A fifth red run in that window died of an unrelated
  // puppeteer "execution context was destroyed" — a navigation race that is still
  // out there and has been seen once.) Reproducible on a laptop with
  // `HARNESS_CPU_THROTTLE=4` — see the launch block; the runner is slower, not
  // different. The old wait was for `#ggroup` to EXIST,
  // which measured nothing at all: `#ggrouphost` is in the page in TIMELINE view
  // too, so the element was already there, holding the options from the last time
  // the picker was built. The read raced two separate things:
  //
  //   1. `post` returns when the STUB has the command. The page applies it when
  //      the frame arrives over the socket, later. Waited for off the unsaved
  //      tally (`sockSeq - savedSeq`) — a DELIVERY signal, deliberately not the
  //      >= 2 rule being asserted.
  //   2. `render()` calls `mountPicker`, which is `root.render()`, which COMMITS
  //      ASYNCHRONOUSLY. Instrumented, the document was patched and `#dirty` had
  //      already ticked to 30 while `#ggroup` still listed six channels.
  //
  // The second wait is for the picker to be rebuilt — the options differing from
  // the ones standing before the patch — and NOT for them to equal the answer.
  // Waiting on the answer is how this kind of check quietly stops being able to
  // fail, which is the exact thing this block exists to prevent. Delete the
  // filter in `app.ts` and the options never change, so the wait times out and
  // `until` reports it as a named failing check.
  const groupOpts = () =>
    q(`JSON.stringify([...document.querySelectorAll('#ggroup option')].map(o => o.value))`) as unknown as Promise<string>
  const unsavedSeen = async () =>
    parseInt((await q(`document.getElementById('dirty').textContent`) as unknown as string) || '', 10) || 0
  const beforeShapes = await unsavedSeen()
  const optsBeforePatch = await groupOpts()
  await post({ type: 'setTaskChannel', id: 't2', channel: 'shape', value: 's1' })
  await post({ type: 'setTaskChannel', id: 't7', channel: 'shape', value: 's1' })
  await post({ type: 'patchDoc', patch: { shapes: [{ id: 's1', label: 'none', shape: 'soft' }] } })
  await until(`(parseInt(document.getElementById('dirty').textContent) || 0) >= ${beforeShapes + 3}`,
    'the three commands that collapse the shape channel to reach the page')
  await setNative('#view', 'graph', 'HTMLSelectElement')
  await until(`JSON.stringify([...document.querySelectorAll('#ggroup option')].map(o => o.value))`
    + ` !== ${JSON.stringify(optsBeforePatch)}`,
    'the grouping picker to be rebuilt after the shape channel collapsed')
  const optsAfterPatch = await groupOpts()
  check('a channel left with one value drops out of the grouping list',
    optsAfterPatch === JSON.stringify(['', 'lanes', 'colors', 'borders', 'fills']), optsAfterPatch)

  // ---- THE GRAPH LENS WITHOUT ITS LIBRARY -----------------------------------
  //
  // The check above this one — "the graph lens either draws or says why it could
  // not" — has reported "drew" on every machine that ran it, because the CDN is
  // reachable from a laptop and from CI. The harness comment claiming it "has no
  // route to" cytoscape was simply false, so `#cyfail` had never been rendered by
  // a test in its life. It is a React component now, and this is the first time
  // anything has looked at it.
  await page.setRequestInterception(true)
  const killCy = (r: { url(): string; abort(): unknown; continue(): unknown }) =>
    r.url().includes('cytoscape') ? r.abort() : r.continue()
  page.on('request', killCy)
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the plan back after the reload')
  await setNative('#view', 'graph', 'HTMLSelectElement')
  await until(`!!document.getElementById('cyfail')`, 'the graph lens to report it could not load')
  check('a graph lens whose library will not load says so, and says the dates are fine',
    (await q(`document.getElementById('cyfail').textContent`) as unknown as string)
      .includes('every date on it is still right'),
    (await q(`document.getElementById('cyfail').textContent`) as unknown as string)
      .replace(/\s+/g, ' ').slice(0, 80))
  page.off('request', killCy)
  await page.setRequestInterception(false)
  await setNative('#view', 'timeline', 'HTMLSelectElement'); await settle()

  // ---- THE FRONT DOOR -------------------------------------------------------
  //
  // `#landing` is what a first visit lands on, and nothing had ever opened it.
  // The recents list is the interesting half: it is read out of localStorage, and
  // a token in it is a CAPABILITY — so what it must never do is show one.
  await page.evaluate(`localStorage.setItem('ts:recent', JSON.stringify([
    { tok: 'aaaaaaaaaaaaaaaaaaaaaa', title: 'A plan from before', ts: Date.now() - 3600e3 }]))`)
  await page.evaluate(`document.getElementById('help').click()`)
  await until(`!document.getElementById('landing').hidden`, 'the front door')
  // `#recents li`, NOT `li, .recent`. A recent is an `<li>` wrapping a
  // `<button class="recent">`, so the two-part selector counts every plan twice —
  // the first version of this check asserted two entries and passed, against one
  // plan listed once. Two elements is not two plans.
  check('the front door opens with its doors and the plans you have opened before',
    (await q(`document.querySelectorAll('#landing .door, #landing .land-new').length`) as unknown as number) >= 3
      && (await q(`document.getElementById('recents-block').hidden`) as unknown as boolean) === false
      && (await q(`document.querySelectorAll('#recents li').length`) as unknown as number) === 1,
    await q(`JSON.stringify([...document.querySelectorAll('#recents li')].map(e => e.textContent.trim()))`) as unknown as string)
  check('and a recent names the plan without printing the token that opens it',
    (await q(`document.getElementById('recents').textContent`) as unknown as string).includes('A plan from before')
      && !(await q(`document.getElementById('recents').innerHTML`) as unknown as string).includes('aaaaaaaaaaaaaaaaaaaaaa'),
    (await q(`document.getElementById('recents').textContent`) as unknown as string).replace(/\s+/g, ' ').slice(0, 60))
  // The one door that does not navigate.
  await page.evaluate(`document.getElementById('door-styles').click()`); await settle()
  check('the styles door swaps the front door for the swatch wall',
    (await q(`document.getElementById('landing').hidden`) as unknown as boolean) === true
      && (await q(`document.getElementById('wall').hidden`) as unknown as boolean) === false)
  await page.evaluate(`document.getElementById('wall-close').click()`); await settle()
  await page.evaluate(`document.getElementById('help').click()`); await settle()
  await page.keyboard.press('Escape'); await settle()
  check('and Escape closes the front door again',
    (await q(`document.getElementById('landing').hidden`) as unknown as boolean) === true)

  // ---- THE CHART'S BACKGROUND -----------------------------------------------
  //
  // The day bands, the month and sprint rules, the today line, the milestone
  // flags and the axis that labels them. React's now, and until this section
  // nothing had ever looked at any of it — `.gl.deadline` was touched once, as a
  // coordinate to compare a peer's cursor against, which is not the same as
  // checking it is there for the right reason.
  //
  // The invariant worth having is the one that survives a rescale: A LABEL AND
  // ITS RULE ARE THE SAME PIXEL. They are built from the same `X(w)` in the same
  // loop, so they can only disagree if somebody splits that loop — and a month
  // label sitting a few pixels off its line is the kind of thing that reads as
  // "about right" forever.
  const furniture = async () => JSON.parse(await q(`JSON.stringify({
    gutter: document.querySelectorAll('#axis .axgut').length,
    monLabels: [...document.querySelectorAll('#axis .ax.mon')].map(e => [e.textContent, parseFloat(e.style.left)]),
    monRules: [...document.querySelectorAll('#grid .gl.mon')].map(e => parseFloat(e.style.left)),
    today: document.querySelectorAll('#grid .gl.today').length,
    flags: [...document.querySelectorAll('#axis .ax.flag')].map(e => e.textContent),
    bands: [...document.querySelectorAll('#grid .nwd')].map(e => parseFloat(e.style.width)),
  })`) as unknown as string) as { gutter: number; monLabels: [string, number][]; monRules: number[];
                                  today: number; flags: string[]; bands: number[] }
  const bg = await furniture()
  check('the axis has its sticky gutter and one labelled rule per month on screen',
    bg.gutter === 1 && bg.monLabels.length >= 3 && bg.monLabels.length === bg.monRules.length,
    `${bg.gutter} gutter, ${bg.monLabels.length} labels, ${bg.monRules.length} rules`)
  check('and every month label sits on exactly its own rule, to the pixel',
    bg.monLabels.every((l, i) => l[1] === bg.monRules[i]),
    JSON.stringify(bg.monLabels.map((l, i) => [l[0], l[1], bg.monRules[i]])))
  check('now is a line of its own, and each milestone gets one with a caption',
    bg.today === 1 && bg.flags.length === 2 && bg.flags.some(f => f.startsWith('NOW')),
    `${bg.today} now line(s), flags ${JSON.stringify(bg.flags)}`)
  // ---- WHAT TIME AM I POINTING AT -------------------------------------------
  //
  // The corner readout names the day under the pointer, and once the axis is
  // drawing clock ticks it names the hour too. The invariant is the LINKAGE, not
  // either state on its own: the readout and the ticks read the same `TICK_STEP`,
  // so they must never describe the chart at different resolutions. A check that
  // only asserted "it says an hour when zoomed in" would still pass if somebody
  // gave the readout its own copy of the ladder and the two drifted a notch
  // apart — which is the failure worth catching, because at one zoom setting out
  // of five it is invisible.
  //
  // MID-CHART, not at the left edge: `x < LABW` returns early by design, and a
  // pointer landing in the label column would read the blank that produces as a
  // pass at any zoom.
  const A_CLOCK = /\d(?::\d\d)?\s*(?:am|pm)$|\b\d\d:\d\d$/i
  const pointAt = async (frac: number) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('chart'), r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true,
        clientX: r.left + r.width * ${frac}, clientY: r.top + r.height / 2 }));
    })()`)
    await settle()
    return JSON.parse(await q(`JSON.stringify({
      gut: document.querySelector('#axis .axgut').textContent,
      ticks: [...document.querySelectorAll('#axis .ax.wk, #axis .ax.sub')].map(e => e.textContent),
    })`) as unknown as string) as { gut: string; ticks: string[] }
  }
  const zoomWide = await q(`document.getElementById('zoom').value`) as unknown as string
  const dayOnly = await pointAt(0.8)
  check('the corner says which day the pointer is on, weekday first',
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} \d+/.test(dayOnly.gut), JSON.stringify(dayOnly.gut))
  check('and it says NO time while the axis is not drawing any',
    !dayOnly.ticks.some(t => A_CLOCK.test(t)) && !A_CLOCK.test(dayOnly.gut),
    `gutter ${JSON.stringify(dayOnly.gut)}, ticks ${JSON.stringify(dayOnly.ticks.slice(0, 6))}`)
  // "1 day" across the window, which is comfortably inside the sub-day rungs of
  // CAL_STEPS at any window this harness runs at.
  await setNative('#zoom', '1', 'HTMLSelectElement')
  await settle()
  const close = await pointAt(0.8)
  check('zoomed until the axis draws clock ticks, the corner names the hour as well',
    close.ticks.some(t => A_CLOCK.test(t)) && A_CLOCK.test(close.gut)
      && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} \d+ · /.test(close.gut),
    `gutter ${JSON.stringify(close.gut)}, ticks ${JSON.stringify(close.ticks.slice(0, 6))}`)
  const hourOf = (label: string) => {
    const m = /(\d+)(?::(\d\d))?\s*(am|pm)?/i.exec(label)
    if (!m) return NaN
    return m[3] ? (+m[1]! % 12) + (/pm/i.test(m[3]) ? 12 : 0) : +m[1]!
  }

  // AND THE RULE ITSELF IS AT NOW, not at the top of the day. This is what the
  // whole `todayD()` -> `nowD()` change is for, and reverting it is otherwise
  // invisible at every zoom coarser than an hour — a midnight rule and a 2pm
  // rule are the same pixel when a day is 20px wide.
  //
  // AGAINST THE REAL CLOCK, read in the plan's zone (`planWall`), which is the
  // only reference here that does not come from the code under test. A reverted rule reads "12am" while the
  // clock says something else. Weakest between midnight and 1am, when a rule at
  // the top of the day and a rule at now genuinely are the same hour — worth
  // knowing about, not worth a fake clock to close.
  const nowCap = await q(`(() => {
    const f = [...document.querySelectorAll('#axis .ax.flag')].map(e => e.textContent)
      .find(t => t.startsWith('NOW'));
    return f || '';
  })()`) as unknown as string
  const wall = planWall(), wallHour = wall.getUTCHours()
  // THE CAPTION IS AS OLD AS THE LAST RENDER, a few seconds before the clock is
  // read here — so a run that straddles the top of the hour saw "10am" against
  // 11:00 (1 run in ~60). In the first two minutes past the hour the previous
  // hour is also an honest caption; any other mismatch still fails.
  const capHour = hourOf((nowCap.split('\u00b7')[1] ?? ''))
  check('and the NOW rule is captioned with the hour it is actually standing at',
    capHour === wallHour || (wall.getUTCMinutes() < 2 && capHour === (wallHour + 23) % 24),
    `${JSON.stringify(nowCap)} against the plan zone's clock reading ${wallHour}:${String(wall.getUTCMinutes()).padStart(2, '0')}`)

  // THE HOUR YOU ARE STANDING IN, FLOORED — and this is the check that tells
  // floored apart from rounded, which is the whole difference between a readout
  // that names where you are and one that names where you nearly are.
  //
  // Nine tenths of the way from one clock tick to the next: floor puts you in
  // the hour that many whole hours past the tick, rounding puts you in the next
  // one. Derived from the ticks the page actually drew rather than from a
  // hardcoded spacing, so it holds at whatever rung of CAL_STEPS this window
  // lands on — and it pins the readout to the AXIS, not to a second opinion
  // about what time it is.
  const pair = JSON.parse(await q(`JSON.stringify((() => {
    const ts = [...document.querySelectorAll('#axis .ax.wk, #axis .ax.sub')]
      .map(e => ({ text: e.textContent, x: e.getBoundingClientRect().left }))
      .sort((a, b) => a.x - b.x);
    for (let i = 0; i < ts.length - 1; i++)
      if (/^\\d/.test(ts[i].text) && /^\\d/.test(ts[i + 1].text)) return [ts[i], ts[i + 1]];
    return null;
  })())`) as unknown as string) as [{ text: string; x: number }, { text: string; x: number }] | null
  if (!pair) {
    check('two adjacent clock ticks to measure the readout against', false,
      'the axis drew none — this check cannot run, which is a failure, not a pass')
  } else {
    const perTick = (hourOf(pair[1].text) - hourOf(pair[0].text) + 24) % 24
    await page.evaluate(`(() => {
      const el = document.getElementById('chart'), r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true,
        clientX: ${pair[0].x} + 0.9 * ${pair[1].x - pair[0].x}, clientY: r.top + r.height / 2 }));
    })()`)
    await settle()
    const got = await q(`document.querySelector('#axis .axgut').textContent`) as unknown as string
    const want = (hourOf(pair[0].text) + Math.floor(0.9 * perTick)) % 24
    check('and the hour is the one you are standing IN, not the one you are nearest',
      perTick > 0 && hourOf(got.split('\u00b7')[1] ?? '') === want,
      `${pair[0].text} +0.9 of ${perTick}h -> ${JSON.stringify(got)}, wanted hour ${want}`)
  }
  await setNative('#zoom', zoomWide, 'HTMLSelectElement')
  await settle()

  // ONE BAND PER RUN OF NON-WORKING DAYS, not one per day: a weekend is one shape
  // because it reads as one gap, and a holiday touching a weekend is one longer
  // gap. Every band coming out the same width is what that collapsing silently
  // NOT happening looks like.
  //
  // ON THE BIG PLAN, because the small one has no calendar at all — `CAL.allOn`
  // is true for it and it correctly draws none. A check for this against that
  // fixture asserts zero bands and calls it a pass.
  await fetch(`http://127.0.0.1:${PORT}/__mode?big=1`)
  await reloadPage()
  await until(`document.querySelectorAll('#grid .nwd').length > 0`, 'the day bands on a plan with a calendar')
  const bands = (await furniture()).bands
  check('a weekend is drawn as one band, and a holiday beside one makes it longer',
    bands.length > 0 && new Set(bands.map(Math.round)).size > 1,
    `${bands.length} bands, widths ${[...new Set(bands.map(Math.round))].sort((x, y) => x - y).join(',')}`)
  // THE FIXTURE'S HOLIDAYS ARE DATE OVERRIDES NOW (v4 -> v10), seven of them, most already past. Settings lists
  // only today and later, and an edit elsewhere must carry the past ones along untouched.
  await page.evaluate(`document.getElementById('cog').click()`)
  await settle()
  const todayIso = await q(`new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())`) as unknown as string
  const held = ['2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']
  const listed = JSON.parse(await q(`JSON.stringify([...document.querySelectorAll('#wwedit .wkrow[data-date]')].map(r => r.dataset.date))`) as unknown as string) as string[]
  check('Settings lists only the date overrides from today on', listed.join() === held.filter(d => d >= todayIso).join(), `${todayIso}: ${listed.join()}`)
  await page.evaluate(`document.querySelector('#wwedit .wkrow[data-day="sat"] .hadd').click()`)
  await settle()
  const keptDates = Object.keys(((await probe()) as { wire: { patch?: any }[] }).wire.at(-1)?.patch?.hours?.dates ?? {})
  check('and an edit still sends the past ones, untouched', held.every(d => keptDates.includes(d)), keptDates.join())
  await page.evaluate(`document.getElementById('set-close').click()`)
  await fetch(`http://127.0.0.1:${PORT}/__mode?big=0`)
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the small plan back')

  // ---- WHAT THE ARROWS SAY, NOT JUST THAT THERE ARE SOME --------------------
  //
  // The arrow layer is React's now, and it was the last region assembling markup
  // as a string — SVG, in its case. Three checks already count paths and size the
  // svg; none of them looked at PAINT, which is where the meaning is: hue is the
  // DIRECTION, the dash is the DISTANCE, and the one wide line is the dependency
  // actually holding the task's start. All three could have been dropped in the
  // rewrite and every existing check would still have passed.
  await page.evaluate(`${rowOf2('t4')}.querySelector('.bar').click()`)
  await settle()
  const painted = JSON.parse(await q(`JSON.stringify([...document.querySelectorAll('#arrows path')].map(p => ({
    pin: p.getAttribute('data-pin') === '1',
    w: +p.getAttribute('stroke-width'),
    dash: p.getAttribute('stroke-dasharray') !== 'none',
    op: +p.getAttribute('opacity'),
  })))`) as unknown as string) as { pin: boolean; w: number; dash: boolean; op: number }[]
  check('the pinning dependency is drawn wider than the rest, and is marked as the one',
    painted.some(p => p.pin && p.w > 2.5) && painted.filter(p => p.pin).length >= 1,
    JSON.stringify(painted.filter(p => p.pin)))
  check('a second hop is dashed where the first is solid — distance, not decoration',
    painted.some(p => p.dash && p.op === 1) && painted.some(p => !p.dash && p.op === 1),
    `${painted.filter(p => p.dash).length} dashed, ${painted.filter(p => !p.dash).length} solid`)
  check('and an unrelated dependency is left muted rather than removed',
    painted.some(p => p.op < 1), `opacities ${[...new Set(painted.map(p => p.op))].sort().join(',')}`)

  // ---- SCROLL SURVIVES A RENDER, ON A DOCUMENT LONG ENOUGH TO MEAN IT -------
  //
  // The existing scroll check runs the ELEVEN ROW fixture, whose chart barely
  // scrolls — `scrollLeft` clamps to 15px — and the bug it is meant to guard is
  // about a LONG document: rebuilding every row shortened the page for an
  // instant, the browser clamped `scrollTop`, and the clamp survived. "Clicking
  // anything jumps me to the top."
  //
  // `render()` has carried a hand-rolled save/restore for that ever since, with a
  // comment saying it is no longer known to be load-bearing and asking for
  // exactly this observation: 135 rows, scrolled well down, holding position
  // through a render caused by an edit.
  await mode('big=1')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length === ${BIG.tasks.length}`, 'the long plan')
  // THE PAGE DOES NOT SCROLL ON `window` ANY MORE, which is what this check was
  // reading: pinning the horizontal scrollbar to the bottom of the window put
  // `overflow-y:hidden` on the body and moved the vertical scroll inside
  // `#chart`. So `window.scrollY` is nailed to 0 no matter how far down you are —
  // the failure detail was `{"y":0,"x":400}`, a horizontal scroll that worked
  // beside a vertical one that could not. Both axes belong to the same element
  // now, and asking it directly is also a stronger check: it is the element whose
  // scroll position a render was destroying.
  const where = () => q(`JSON.stringify({ y: Math.round(document.getElementById('chart').scrollTop),
    x: Math.round(document.getElementById('chart').scrollLeft) })`) as unknown as Promise<string>
  // ZOOMED IN FIRST, or the horizontal axis proves nothing here either: at the
  // default scale the whole plan fits and `scrollLeft` clamps to 10px on 135
  // tasks exactly as it clamps to 15 on eleven. The narrowest preset makes the
  // chart genuinely wider than its window.
  const tightest = await q(`(() => {
    const days = [...document.querySelectorAll('#zoom option')]
      .map(o => +o.value).filter(v => v > 0);
    return String(Math.min(...days));
  })()`) as unknown as string
  await setNative('#zoom', tightest, 'HTMLSelectElement')
  await settle()
  await page.evaluate(`(() => { const c = document.getElementById('chart');
    c.scrollTop = 900; c.scrollLeft = 400; })()`)
  await settle()
  const deep = JSON.parse(await where()) as { y: number; x: number }
  check('a 135-row plan can actually be scrolled deep enough for this to mean anything',
    deep.y > 300 && deep.x > 100, `${JSON.stringify(deep)} at ${tightest} days across`)
  // A COMMAND FROM THE ROOM, so a real render runs — and one nobody in this tab
  // asked for, which is the case the restore was written for.
  await post({ type: 'renameTask', id: BIG.tasks[0]!.id, label: 'Renamed from the room' })
  await until(`${rowOf2(BIG.tasks[0]!.id)}.querySelector('.rowlabel').textContent.includes('Renamed')`,
    'the edit to land on the long plan')
  await settle()
  check('and a render caused by somebody else leaves it exactly where it was',
    (await where()) === JSON.stringify(deep), `${JSON.stringify(deep)} -> ${await where()}`)
  await mode('big=0')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the small plan back after the scroll check')

  // ---- FORKING AN ARCHIVED VERSION ------------------------------------------
  //
  // The other thing you can do with the archive, after Compare and Playback: copy
  // one OUT into a plan of its own. It creates a PLAN, which is why nothing had
  // ever driven it, and it NAVIGATES — `saveAs` sets the hash and reloads,
  // because the page has to rebuild around a different socket, room and archive.
  //
  // THE MIGRATION LADDER RUNS ON THE WAY OUT. An archived document is the most
  // likely thing in this tool to be old, and the server refuses anything that is
  // not schemaVersion 4 — so an unmigrated fork would fail at the door with a
  // message about a schema, for a version this panel is happily drawing a finish
  // date for.
  // TWO FORKS, and they are different paths: `#fork` copies the LIVE plan, the
  // history panel's copies an archived VERSION. Checking one and calling it
  // covered was a near miss — a `grep` for `fork()` that filtered out
  // `forkVersion` also filtered out the line wiring `#fork` to it.
  const liveForkBefore = ((await probe()) as { created: string[] }).created.length
  await page.evaluate(`document.getElementById('fork').click()`)
  await until(`location.hash.startsWith('#tok')`, 'the live plan fork')
  check('forking the live plan makes a copy of it, named as one',
    /— copy$/.test(((await probe()) as { created: string[] }).created.slice(liveForkBefore)[0] ?? ''),
    JSON.stringify(((await probe()) as { created: string[] }).created.slice(liveForkBefore)))
  await page.evaluate(`location.hash = 'harnesstoken0000000000'`)
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the harness plan back')

  await page.evaluate(`document.getElementById('histbtn').click()`)
  await until(`document.querySelector('#hist-list .hfork[data-n="4"]')`, 'the History rows')
  const forkBefore = ((await probe()) as { created: string[] }).created.length
  await page.evaluate(`document.querySelector('#hist-list .hfork[data-n="4"]').click()`)
  await until(`location.hash.startsWith('#tok')`, 'the fork to open the plan it made')
  const forked = ((await probe()) as { created: string[] }).created.slice(forkBefore)
  check('forking a save creates ONE new plan, titled after the version it came from',
    forked.length === 1 && /— from save #4$/.test(forked[0] ?? ''), JSON.stringify(forked))
  check('and it takes you to it, because a fork you cannot reach is a plan nobody can open',
    (await q(`location.hash`) as unknown as string).length > 10
      && (await q(`location.hash`) as unknown as string) !== '#harnesstoken0000000000',
    await q(`location.hash`) as unknown as string)
  // WAIT FOR THE PLAN, NOT FOR THE HASH. `saveAs` sets `location.hash` and THEN
  // reloads, so a hash that has changed says the fork was made, not that the page
  // it opened has finished arriving. Asserting rows straight after the hash
  // passed by luck once and failed the moment another reload was added above it.
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the forked plan to finish loading')
  check('and the copy is a plan in its own right, drawn from the version it forked',
    (await rows()) > 0, `${await rows()} rows`)
  // Back to the plan the rest of this run is about.
  await page.evaluate(`location.hash = 'harnesstoken0000000000'`)
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the harness plan back after the fork')

  // ---- SORTING THE TEAMS ----------------------------------------------------
  //
  // The Order panel was covered and this button was not. It is the only control
  // that reorders LANES, and lane order is a scheduling input like queue order:
  // it leaves no trace beyond the array it rewrites and draws no arrow.
  //
  // ON A FIXTURE THAT NEEDS SORTING, which neither of the others is — see
  // SORTABLE. Written against the big plan first, this passed down the "already
  // in the best order" branch and proved nothing: the action never ran.
  await mode('sortme=1')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .lane-head').length === 2`, 'the two-team plan')
  const laneHeads = () => q(`JSON.stringify([...document.querySelectorAll('#grid .lane-head')]
    .map(h => (h.textContent.match(/Team [XY]/) || [''])[0]))`) as unknown as Promise<string>
  check('the plan starts with its one dependency pointing UP the chart',
    (await laneHeads()) === JSON.stringify(['Team X', 'Team Y']), await laneHeads())
  await until(`!!document.querySelector('#msbar .ms.reord:not(.busy)')`, 'the Order chip on the two-team plan')
  await page.evaluate(`document.querySelector('#msbar .ms.reord').click()`)
  await until(`!!document.querySelector('#reorder-body [data-sortlanes]')`, 'the Sort teams button')
  const beforeSort = (await sent()).length
  await page.evaluate(`document.querySelector('#reorder-body [data-sortlanes]').click()`)
  await settle()
  const sortCmd = (await sent()).slice(beforeSort) as { type: string; patch?: { lanes?: { id: string }[] } }[]
  check('Sort teams rewrites the whole lane array as ONE patch, in the better order',
    sortCmd.length === 1 && sortCmd[0]?.type === 'patchDoc'
      && JSON.stringify(sortCmd[0]?.patch?.lanes?.map(l => l.id)) === JSON.stringify(['Y', 'X']),
    JSON.stringify(sortCmd).slice(0, 110))
  check('and the chart is redrawn with the teams the other way round',
    (await laneHeads()) === JSON.stringify(['Team Y', 'Team X']), await laneHeads())
  check('and it says what it bought, in dependencies that no longer point up',
    /dependencies pointing up 1 of 1 -> 0/.test(await msg()), JSON.stringify(await msg()))
  await page.evaluate(`document.getElementById('reorder-close').click()`)
  await mode('sortme=0')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the small plan back after the lane sort')

  // ---- A PAGE RUNNING A SCHEDULER IT DID NOT SHIP WITH ----------------------
  //
  // The last uncovered banner, and it was recorded as unreachable — "it fires
  // only when the scheduler disagrees with itself, which no fixture can provoke".
  // That was the wrong description of what `selftest()` does, and the right one
  // makes it testable.
  //
  // It is not a unit test that leaked into production. It does not check whether
  // the scheduler is CORRECT — `verify.sched.mjs` and `sync-server/test/` do
  // that at build time, against the code in the repo. It checks WHICH SCHEDULER
  // THIS BROWSER LOADED, and those are different questions because the two halves
  // ship separately and cache separately:
  //
  //     index.html      no-cache                     revalidated every load
  //     /assets/*.js    max-age=31536000, immutable  hashed, so it cannot be stale
  //     /schedule.js    max-age=300, UNHASHED        at the bucket root
  //
  // So for five minutes after a deploy the entrypoint is fresh, the bundle it
  // names is fresh, and the `/schedule.js` that bundle imports can be the
  // previous one. `assert-shared-parity.sh` proves the bucket's copy matches the
  // image's and `smoke.sh` proves the bundle still imports rather than inlines —
  // neither can see what a given browser got. The reference plans are hand-
  // computed in the BUNDLE and run through the SEPARATELY FETCHED scheduler, so
  // a mismatch between the two is exactly what they measure.
  //
  // ON THE TWO-TEAM FIXTURE, and that is not incidental. Break the dependency gate
  // on the ordinary plan and the audit stays SILENT: every dependency in it runs
  // t(n) <- t(n-2), which is the same lane and in queue order, so the lane's own
  // serialisation reproduces exactly the dates the dependencies would have forced
  // and nothing is violated. SORTABLE has the one thing that exposes it — a task
  // in one team waiting on a task in another — so with the gate gone both start
  // on day zero and the audit has something true to say.
  await mode('stale=1&sortme=1')
  await reloadPage()
  await until(`!!document.getElementById('selftestfail')`, 'the self-test to catch a stale scheduler')
  // NULL-SAFE. When the banner is absent — which is what a break of this looks
  // like — a bare `.textContent` throws a puppeteer trace and takes the run with
  // it instead of failing the check that noticed.
  // AND THE TIDYING HAPPENS OUT HERE, not in the page. `\s` inside a template
  // literal is just `s` by the time the browser sees it, so an inlined
  // `.replace(/\s+/g, ' ')` runs as `/s+/g` and deletes every lowercase S from
  // the string under test — "unstamped" arrives as "un tamped" and the assertion
  // fails for a reason that has nothing to do with the page. This is the second
  // time a backslash in an evaluated string has cost a debugging round; the rule
  // is now simply that they do not go in one.
  const selfTestText = async () =>
    ((await q(`(document.getElementById('selftestfail') || {}).textContent || ''`) as unknown as string))
      .replace(/\s+/g, ' ')
  check('a page whose /schedule.js is older than its bundle says so, loudly',
    (await selfTestText()).includes('Scheduler check failed'), (await selfTestText()).slice(0, 90) || 'no banner')
  check('and it names which task the schedule broke, not just that something did',
    /starts \d+(\.\d+)? but waits on \w+ which ends \d/.test(await selfTestText()),
    (await selfTestText()).slice(20, 110) || 'no banner')
  // A WARNING, NOT A TAKEDOWN. The plan still draws: the reader needs to know the
  // dates may be wrong, and taking the chart away would remove the only thing
  // they could check against.
  check('and the plan is still on screen, because a warning is not a takedown',
    (await rows()) === 2, `${await rows()} rows`)
  await mode('stale=0&sortme=0')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the plan back on a fresh scheduler')
  check('and it goes away again once the browser has the scheduler its bundle expects',
    (await q(`!document.getElementById('selftestfail')`) as unknown as boolean) === true)

  // ---- A TOKEN THAT REACHES NOTHING -----------------------------------------
  //
  // The failure this panel exists for is not "the plan is empty" — it is the page
  // showing the DEMO FIXTURE with the hash rewritten, so a refresh could not even
  // recover the link. A plausible wrong chart in a meeting is the worst failure
  // this tool has; an empty grid is merely unhelpful. Nothing had ever checked
  // that it stays empty.
  await mode('gone=1')
  await reloadPage()
  await until(`!!document.getElementById('planfail')`, 'the unopenable-plan banner')
  check('a plan that will not open says so, and says not to read a chart off what is left',
    (await q(`document.getElementById('planfail').textContent`) as unknown as string)
      .includes('Nothing below is this plan'),
    (await q(`document.getElementById('planfail').textContent`) as unknown as string)
      .replace(/\s+/g, ' ').slice(0, 70))
  check('and the fixture is NOT put in its place — the chart stays empty',
    (await rows()) === 0, `${await rows()} rows drawn for a plan that did not load`)
  // AND THE TOOLBAR MUST NOT OUTLIVE THE DOCUMENT. Every one of these reads the
  // document, and two are worse than dead: Save and Revert would go to the server
  // under a token it has already refused.
  check('and every control that needs a document is dead, except the two ways out',
    (await q(`['#add','#save','#revert','#histbtn','#renamebtn','#cog']
       .every(s => document.querySelector(s).disabled)`) as unknown as boolean) === true
      && (await q(`document.getElementById('help').disabled`) as unknown as boolean) === false,
    await q(`JSON.stringify(['#add','#save','#revert','#help']
       .map(s => [s, document.querySelector(s).disabled]))`) as unknown as string)
  await mode('gone=0')
  await reloadPage()
  await until(`document.querySelectorAll('#grid .row').length > 0`, 'the plan back')

  // ---- THE TWO BANNERS THAT SAY THE PAGE CANNOT ANSWER ----------------------
  //
  // The one-shot banners are React's now, and the reason they were left out —
  // "written once and replaced wholesale, so there is no state to reconcile" —
  // was about what React would BUY, not about what it could do. What it buys is
  // that every one of them used to interpolate a value into an HTML string and
  // needed `esc()` at each interpolation, one forgotten call from a plan title or
  // a share TOKEN becoming markup.
  //
  // Six were rewritten with nothing watching any of them, which is not a thing to
  // do twice. These two are the ones a stub can provoke honestly. Last in the run
  // because both leave the page saying it cannot be used.

  // ---- AN EMPTY DESCRIPTION KEEPS THE CARET. It shows the textarea because it
  // is empty, not because it is being edited, so the first letter used to flip it
  // to the rendered view and unmount the box you were typing in.
  await page.evaluate(`document.querySelector('#rows .bar').click()`); await settle()
  await page.evaluate(`(() => { const el = document.querySelector('#insp #desc');
    if (el) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '');
              el.dispatchEvent(new Event('input', { bubbles: true })); } })()`); await settle()
  if (await q(`!document.querySelector('#insp #desc')`)) await page.evaluate(`document.querySelector('#insp .mdview')?.click()`)
  // Unfold if this point in the run left the panel folded, and put it back after.
  let unfolds = 0
  while (unfolds < 3 && await q(`!(document.querySelector('#insp #desc')?.getBoundingClientRect().height > 0)`)) {
    await page.evaluate(`document.getElementById('inspfold').click()`); await settle(); unfolds++
  }
  const descState = await q(`(() => { const el = document.querySelector('#insp #desc'); if (!el) return 'absent';
    const r = el.getBoundingClientRect(); return r.width + 'x' + r.height; })()`)
  await page.evaluate(`document.querySelector('#insp #desc')?.focus()`)
  await page.keyboard.type('ab'); await settle()
  check('typing into an empty description keeps the box and the caret',
    (await q(`document.activeElement?.id === 'desc' && document.activeElement.value === 'ab'`)) as unknown as boolean,
    `${descState} | ` + (await q(`document.activeElement?.id + ' ' + JSON.stringify(document.querySelector('#insp #desc')?.value)`) as unknown as string))
  for (let i = 0; i < (3 - unfolds) % 3; i++) { await page.evaluate(`document.getElementById('inspfold').click()`); await settle() }
  await page.keyboard.press('Escape'); await settle()

  // ---- COMMENTS: a thread at the foot of the Inspector. Add, edit, delete each
  // go on the wire as their own command, carrying the page's name as `by`, and
  // none of them is a wording edit — nothing else is sent alongside.
  await page.evaluate(`document.querySelector('#rows .bar').click()`); await settle()
  const typeInto = (sel: string, v: string) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const cWire = (await sent()).length
  await typeInto('#insp #newcomment', 'First **comment**'); await page.evaluate(`document.querySelector('#insp #postcomment').click()`); await settle()
  const added = (await sent()).at(-1) as unknown as { type: string; comment: { id: string; by: string; text: string } }
  check('posting a comment sends one addComment, named and dated by this page',
    (await sent()).length === cWire + 1 && added?.type === 'addComment' && !!added.comment?.id && !!added.comment?.by
      && (await q(`document.querySelectorAll('#insp #comments .comment').length`) as unknown as number) === 1
      && (await q(`document.querySelector('#insp #comments .comment .mdview strong')?.textContent`) as unknown as string) === 'comment',
    JSON.stringify(added))
  await page.evaluate(`document.querySelector('#insp [data-cedit]').click()`); await settle()
  await typeInto('#insp #comments .comment textarea', 'Changed'); await page.evaluate(`[...document.querySelectorAll('#insp #comments .comment button')].find(b => b.textContent === 'Save').click()`); await settle()
  check('editing it sends editComment and marks it edited',
    ((await sent()).at(-1) as unknown as { type: string })?.type === 'editComment'
      && (await q(`!!document.querySelector('#insp #comments .cedited')`) as unknown as boolean), JSON.stringify((await sent()).at(-1)))
  await page.evaluate(`document.querySelector('#insp [data-cdel]').click()`); await settle()
  check('and deleting it sends removeComment and empties the thread',
    ((await sent()).at(-1) as unknown as { type: string })?.type === 'removeComment'
      && (await q(`document.querySelectorAll('#insp #comments .comment').length`) as unknown as number) === 0
      && (await sent()).length === cWire + 3, `${(await sent()).length - cWire} commands`)
  await page.keyboard.press('Escape'); await settle()

  // ---- OPENING A TASK SHOWS THE TOP OF ITS PANEL, at the medium and the large size. The
  // comment form sits at the foot of the panel and used to scroll itself into view on every
  // open, so a task with a thread opened scrolled to the bottom (2026-10-04).
  const bars = `document.querySelectorAll('#rows .bar')`
  const inspPx = (js: string) => q(`(() => { const e = document.getElementById('insp'); return ${js}; })()`) as unknown as Promise<number>
  const openFirst = async () => { await page.evaluate(`${bars}[0].click()`); await settle() }
  await openFirst()
  for (let i = 0; i < 8; i++) {
    await typeInto('#insp #newcomment', `Note ${i}\n\n` + 'a fairly long comment, '.repeat(20))
    await page.evaluate(`document.querySelector('#insp #postcomment').click()`); await settle()
  }
  await page.keyboard.press('Escape'); await settle()
  for (const size of ['medium', 'large']) {  // the panel starts folded; each pass is one size up
    // The size is changed while a task is open and the panel closed again, so the measurement below
    // is of a panel that has just been OPENED, not of one that was resized.
    await openFirst(); await page.evaluate(`document.getElementById('inspfold').click()`); await settle(); await page.keyboard.press('Escape'); await settle()
    await openFirst()
    const cls = await q(`document.getElementById('insp').className`) as unknown as string
    const over = await inspPx(`e.scrollHeight - e.clientHeight`), top = await inspPx(`e.scrollTop`)
    check(`opening a task with a long thread shows the top of the panel (${size})`, over > 20 && top === 0,
      `[${cls}] scrollTop ${top}, ${over}px of overflow`)
    await page.evaluate(`document.getElementById('insp').scrollTop = 9999`); await settle()
    await page.evaluate(`${bars}[1].click()`); await settle()
    const top2 = await inspPx(`e.scrollTop`)
    check(`clicking another task from a scrolled panel starts at the top (${size})`, top2 === 0, `[${cls}] scrollTop ${top2}`)
    await page.keyboard.press('Escape'); await settle()
  }
  // Put it back as found: the thread deleted, the panel at the size it started at.
  await openFirst()
  while (await q(`!!document.querySelector('#insp [data-cdel]')`) as unknown as boolean) {
    await page.evaluate(`document.querySelector('#insp [data-cdel]').click()`); await settle()
  }
  await page.evaluate(`document.getElementById('inspfold').click()`); await settle()  // large -> folded, as found
  await page.keyboard.press('Escape'); await settle()

  // ---- LIGHT-DISMISS: a click that does nothing closes the Inspector, like Escape.
  // Real mouse clicks, because the rule is about what the click LANDS on.
  const inspOpen = async () => (await q(`document.getElementById('insp').offsetHeight > 0`)) as unknown as boolean
  const emptyIn = (sel: string) => page.evaluate(`(() => { const box = document.querySelector('${sel}').getBoundingClientRect();
    for (let x = box.right - 4; x > box.left; x -= 6) { const y = box.top + box.height / 2;
      if (document.elementFromPoint(x, y) === document.querySelector('${sel}')) return [x, y]; } return null; })()`) as Promise<[number, number] | null>
  const barAt = await page.evaluate(`(() => { const r = document.querySelector('#rows .bar').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`) as [number, number]
  await page.mouse.click(...barAt); await settle()
  const gap = await emptyIn('#msbar')
  check('light-dismiss: there is empty milestone bar to click', !!gap)
  const chip = await page.evaluate(`(() => { const r = document.querySelector('#legend button').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`) as [number, number]
  await page.mouse.click(...chip); await settle()
  check('light-dismiss: clicking a control leaves the Inspector open', await inspOpen())
  await page.mouse.click(...chip); await settle()   // put the filter back
  if (gap) { await page.mouse.click(...gap); await settle() }
  check('light-dismiss: clicking empty milestone bar closes the Inspector', !(await inspOpen()))

  // ---- THE KANBAN LENS: A DROP IS A SESSION EVENT (ADR 0016), AND ONLY A DROP ACROSS PLACES
  // Checked on the WIRE, like the dependency drawing above: a card in the right
  // column is also what you see when the page redrew and sent nothing.
  await setNative('#view', 'board', 'HTMLSelectElement'); await settle()
  // `paused` drops below In progress's Paused divider; anything else lands at the top of the column.
  const drag = (card: string, col: number, paused = false) => page.evaluate(`(() => {
    const c = ${card}, dt = new DataTransfer(), to = document.querySelectorAll('#board .col')[${col}];
    const div = to.querySelector('.divider.paused');
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientY: ${paused} && div ? div.getBoundingClientRect().bottom + 1 : 0 };
    c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('dragover', at));
    to.dispatchEvent(new DragEvent('drop', at));
    c.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  })()`)
  const first = `document.querySelector('#board .col .card')`
  const boardLabel = await q(`${first}.firstChild.textContent`) as unknown as string
  const inCol = (n: number) => `[...document.querySelectorAll('#board .col')[${n}].querySelectorAll('.card')].find(c => c.firstChild.textContent === ${JSON.stringify(boardLabel)})`
  const last = async () => (await sent()).at(-1) as unknown as { type: string; id: string }
  const wire0 = (await sent()).length
  await drag(first, 0); await settle()
  check('a card dropped on its own column sends nothing', (await sent()).length === wire0)
  await drag(first, 1); await settle()
  check('dropping a not-started card on In progress starts it now', (await last())?.type === 'startTask', JSON.stringify(await last()))
  check('and it sits under Running now',
    (await q(`(() => { const c = ${inCol(1)}; let d = c && c.previousElementSibling;
      while (d && !d.classList.contains('divider')) d = d.previousElementSibling; return d ? d.textContent : null; })()`) as unknown as string)
      ?.startsWith('Running now'))
  const metaOf = () => q(`${inCol(1)}?.querySelector('.meta')?.textContent`) as unknown as Promise<string>
  check('a running card says when it started, absolute then relative, without the word',
    /^\d{1,2}(:\d{2})?(am|pm), (just now|\d+ \w+ ago)$/.test(await metaOf()), await metaOf())
  const wire1 = (await sent()).length
  await drag(inCol(1), 0); await settle()
  check('and it cannot go back to Not started — a worked-on task keeps its session', (await sent()).length === wire1)
  await drag(inCol(1), 1, true); await settle()
  check('dropping it under Paused stops it', (await last())?.type === 'stopTask', JSON.stringify(await last()))
  check('and a paused card says when it stopped, absolute then relative',
    /^\d{1,2}(:\d{2})?(am|pm), (just now|\d+ \w+ ago)$/.test(await metaOf()), await metaOf())
  await drag(inCol(1), 2); await settle()
  check('and dropping it on Done finishes it', (await last())?.type === 'finishTask', JSON.stringify(await last()))
  // DONE IS GROUPED BY WHEN: a divider per bucket with its count, none empty,
  // and a card under "Today" carries only its time — the divider says the day.
  const doneCol = await q(`(() => { const col = document.querySelectorAll('#board .col')[2];
    return { divs: [...col.querySelectorAll('.divider')].map(d => d.textContent),
             cards: col.querySelectorAll('.card').length,
             meta: col.querySelector('.card .meta')?.textContent }; })()`) as unknown as { divs: string[]; cards: number; meta: string }
  check('the Done column puts finished work under a counted "Today" divider, time then how long ago',
    doneCol.divs[0] === `Today · ${doneCol.cards}` && doneCol.divs.every(d => !/ · 0$/.test(d))
      && /^\d{1,2}(:\d{2})?(am|pm), (just now|\d+ \w+ ago)$/.test(doneCol.meta), JSON.stringify(doneCol))
  await drag(inCol(2), 1, true); await settle()
  check('and dragging it back from Done reopens it, paused', (await last())?.type === 'reopenTask', JSON.stringify(await last()))

  // REORDERING INSIDE NOT STARTED: a card dropped on a card of the same team is
  // a place in that team's queue — one moveTaskInLane — and across teams it is
  // refused (each team is its own queue). Lane A holds the even tasks, B the odd.
  const onCard = (dragged: string, target: string, above: boolean) => page.evaluate(`(() => {
    const col = document.querySelectorAll('#board .col')[0];
    const find = l => [...col.querySelectorAll('.card')].find(c => c.firstChild.textContent === l);
    const c = find(${JSON.stringify(dragged)}), t = find(${JSON.stringify(target)});
    if (!c || !t) return false;
    const r = t.getBoundingClientRect(), dt = new DataTransfer();
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientY: ${above} ? r.top + 2 : r.bottom - 2 };
    c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    t.dispatchEvent(new DragEvent('dragover', at));
    t.dispatchEvent(new DragEvent('drop', at));
    c.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`) as Promise<boolean>
  const reWire1 = (await sent()).length
  const found = await onCard('Task 8', 'Task 4', true); await settle()
  const reMove = (await sent()).at(-1) as unknown as { type: string; id: string; toIndex: number }
  check('dropping a card on a teammate\'s card reorders their queue',
    found && (await sent()).length === reWire1 + 1 && reMove?.type === 'moveTaskInLane' && reMove.id === 't8'
      && Number.isInteger(reMove.toIndex), JSON.stringify(reMove))
  const reWire2 = (await sent()).length
  await onCard('Task 8', 'Task 5', true); await settle()
  check('and a card from another team is not a place in this queue', (await sent()).length === reWire2)
  // A REDRAW KEEPS EACH COLUMN'S SCROLL. Every column is its own scroller and
  // `drawBoard` rebuilds them, so picking a card — or any inbound command —
  // used to snap the column you were reading back to the top.
  await q(`document.getElementById('board').style.height = '160px'`)
  const scrolled = await q(`(() => { const c = document.querySelectorAll('#board .col')[0]; c.scrollTop = 80; return c.scrollTop; })()`) as unknown as number
  await q(`document.querySelectorAll('#board .col')[0].querySelectorAll('.card')[3].click()`); await settle()
  const kept = await q(`document.querySelectorAll('#board .col')[0].scrollTop`) as unknown as number
  check('picking a card keeps the column scrolled where it was', scrolled > 0 && kept === scrolled, `${scrolled} -> ${kept}`)
  await q(`document.getElementById('board').style.height = ''`)
  await page.keyboard.press('Escape'); await settle()
  await setNative('#view', 'timeline', 'HTMLSelectElement'); await settle()

  // ---- THE CALENDAR LENS: read-only, a day or a week of sessions, promises and forecast.
  await setNative('#view', 'calendar', 'HTMLSelectElement'); await settle()
  await setNative('#calspan', 'week', 'HTMLSelectElement'); await settle()
  const calCount = (sel: string) => q(`document.querySelectorAll('#cal ${sel}').length`) as unknown as Promise<number>
  const calTitle = () => q(`document.getElementById('caltitle').textContent`) as unknown as Promise<string>
  check('calendar: the lens replaces the chart and shows a week of days',
    (await q(`!document.getElementById('cal').hidden && document.getElementById('chart').hidden`) as unknown as boolean)
    && (await calCount('.calday')) === 7, String(await calCount('.calday')))
  check('calendar: the forecast is drawn as blocks', (await calCount('.calev.computed')) > 0, String(await calCount('.calev')))
  check('calendar: Zoom stays, in hours', (await q(`!document.getElementById('zoomwrap').hidden
    && [...document.querySelectorAll('#zoom option')].some(o => / hours$/.test(o.textContent))`) as unknown as boolean) === true)
  const h16 = await q(`document.querySelector('#cal .calgrid').offsetHeight`) as unknown as number
  await setNative('#zoom', '8', 'HTMLSelectElement'); await settle()
  const h8 = await q(`document.querySelector('#cal .calgrid').offsetHeight`) as unknown as number
  await setNative('#zoom', '16', 'HTMLSelectElement'); await settle()
  check('calendar: showing half the hours draws each hour twice as tall', Math.abs(h8 - 2 * h16) <= 2, `${h16} -> ${h8}`)
  // A CLICK PICKS, and nothing is written: the lens is read-only.
  const calWire = (await sent()).length
  await q(`document.querySelector('#cal .calev').click()`); await settle()
  check('calendar: clicking a block opens its task in the Inspector', await inspOpen())
  check('calendar: and marks every block of that task', (await calCount('.calev.sel')) > 0)
  check('calendar: and sends nothing', (await sent()).length === calWire)
  // F BRINGS THE SELECTED TASK BACK into view from wherever you stepped to.
  const week0 = await calTitle()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await settle()
  check('calendar: → steps a week', (await calTitle()) !== week0)
  await page.keyboard.press('f'); await settle()
  check('calendar: F frames the selected task', (await calCount('.calev.sel')) > 0, await calTitle())
  await setNative('#calspan', 'day', 'HTMLSelectElement'); await settle()
  check('calendar: Day shows one column', (await calCount('.calday')) === 1)
  await q(`document.getElementById('caltoday').click()`); await settle()
  // THE WEEK STARTS WHERE THE PLAN SAYS (`weekStart`), and only the display moves.
  await setNative('#calspan', 'week', 'HTMLSelectElement'); await settle()
  const calRelay = (cmd: unknown) => fetch(`http://127.0.0.1:${PORT}/api/commands`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
  await calRelay({ type: 'patchDoc', patch: { weekStart: 1 } }); await settle()
  await until(`/^Mon/.test(document.getElementById('caltitle').textContent)`, 'the calendar week to start on Monday')
  check('calendar: weekStart 1 starts the week on Monday', /^Mon/.test(await calTitle()), await calTitle())
  await calRelay({ type: 'patchDoc', patch: { weekStart: null } }); await settle()
  await until(`/^Sun/.test(document.getElementById('caltitle').textContent)`, 'the calendar week back on Sunday')
  await page.keyboard.press('Escape'); await settle()
  await setNative('#view', 'timeline', 'HTMLSelectElement'); await settle()

  // A DEPENDENCY CYCLE HAS NO DATES TO DRAW, and the blank chart has to say which
  // of the two reasons it is blank: no plan, or no schedule.
  await mode('cycle=1')
  await reloadPage()
  await until(`!!document.getElementById('schedfail')`, 'the unschedulable-plan banner')
  check('a plan that cannot be scheduled says so, instead of drawing an empty chart',
    (await q(`document.getElementById('schedfail').textContent`) as unknown as string)
      .includes('This plan cannot be scheduled'),
    (await q(`document.getElementById('schedfail').textContent`) as unknown as string)
      .replace(/\s+/g, ' ').slice(0, 80))
  // The message is the scheduler's own words, and it reaches the page as TEXT.
  // Interpolated into HTML it needed escaping; there is nothing left to forget.
  check('and it carries the scheduler’s own reason, as text rather than as markup',
    (await q(`(() => { const b = document.getElementById('schedfail');
       return b.textContent.toLowerCase().includes('cycle') && b.querySelectorAll('script').length === 0;
     })()`) as unknown as boolean) === true)
  await mode('cycle=0')

  // A PARKED SERVICE IS NOT AN OUTAGE. `/api/*` never wakes anything, so the page
  // is the only thing that can tell the difference between "asleep" and "broken"
  // — and it has about a minute of nothing to explain while it waits.
  await mode('waking=1')
  await reloadPage('domcontentloaded')
  await until(`!!document.getElementById('wakesplash')`, 'the wake splash')
  check('a parked server gets a splash that says it is parked, not an error',
    (await q(`document.getElementById('wakesplash').textContent`) as unknown as string)
      .includes('Waking the server'),
    (await q(`document.getElementById('wakesplash').textContent`) as unknown as string)
      .replace(/\s+/g, ' ').slice(0, 70))
  check('and it shows how long it has been waiting rather than an endless bar',
    /Waiting \d+s/.test(await q(`document.getElementById('wakesplash').textContent`) as unknown as string))
  await mode('waking=0')

  // THE PAGE'S OWN AUDIT WITH WORKING HOURS (ADR 0014). It runs once, at boot, so
  // it is asked of a fresh load of a plan that has them; it measured spans in whole
  // days once, and flagged every task. Served by the stub, which is stateless.
  await mode('hours=1')
  await reloadPage()
  check('with working hours set, the scheduler audit agrees with every span',
    (await q(`!document.getElementById('selftestfail')`) as unknown as boolean) === true,
    (await q(`(document.getElementById('selftestfail') || {}).textContent || ''`) as unknown as string).slice(0, 300))
  await mode('hours=0')

  // LAST, because it selects a random task and scrolls to it, which later checks would inherit
  // (a selection left over from the dice was enough to change the pinned panel's size under them).
  await reloadPage()
  // THE DICE picks from what the lens lets through: with the find box narrowed to
  // "Task 1" it must land on an undimmed row, many times over, and never a dimmed one.
  await setNative('#q', 'Task 1')
  await settle()
  let strayed = 0, landed = 0
  for (let i = 0; i < 12; i++) {
    await page.evaluate(`document.getElementById('dice').click()`)
    await settle()
    const onUndimmed = await q(`(() => { const l = document.querySelector('#grid .rowlabel.sel');
      return !!l && !l.closest('.row').classList.contains('dim'); })()`) as unknown as boolean
    onUndimmed ? landed++ : strayed++
  }
  check('the dice only lands on rows the filter lets through', landed === 12 && strayed === 0,
    `${landed} landed, ${strayed} strayed`)
  await page.evaluate(`document.getElementById('clearfilter').click()`)
  await settle()
  await page.evaluate(`document.getElementById('dice').click()`)
  await settle()
  check('with nothing filtered the dice still selects a task',
    (await q(`!!document.querySelector('#grid .rowlabel.sel')`) as unknown as boolean) === true)

  // A REPEAT RULE ROUND-TRIPS THROUGH THE INSPECTOR: the button needs a Not before (the first occurrence), writes `setRecur`
  // through the shared applier (which makes the next copy), and the control becomes a read-out with a stop. Last in the run
  // on purpose: it adds a row, and earlier checks count them.
  // 'Task 2', not the 'Task 2X' rename: the reload above served the plan fresh. A pick that finds no row left the dice's
  // selection in place, and one time in eleven that was the finished Task 3, whose repeat adds two copies (rows 11 -> 13).
  check('the repeat check selects its task', await pick('Task 2') === 'ok')
  await page.evaluate(`document.querySelector('#insp #nbn').click()`)
  await settle()
  const rowsBeforeRepeat = await q(`document.querySelectorAll('#grid .row').length`) as unknown as number
  await page.evaluate(`document.querySelector('#insp #recb').click()`)
  await settle()
  check('Repeat makes the rule a read-out and adds the next copy',
    /every 1 week/.test(await q(`(document.querySelector('#insp #rec') || {}).textContent || ''`) as unknown as string)
      && (await q(`document.querySelectorAll('#grid .row').length`) as unknown as number) === rowsBeforeRepeat + 1,
    `${await q(`document.querySelector('#insp #lab').value`)}: rows ${rowsBeforeRepeat} -> ${await q(`document.querySelectorAll('#grid .row').length`)}`)
  await page.evaluate(`document.querySelector('#insp #recx').click()`)
  await settle()
  check('and stopping it brings the Repeat button back',
    (await q(`!!document.querySelector('#insp #recb') && !document.querySelector('#insp #rec')`) as unknown as boolean) === true)

  // PLANNED STRETCHES ROUND-TRIP THROUGH THE INSPECTOR: `plan` writes `setPlanned` through the shared applier and the stretch comes
  // back as a pair of editable times; ✓ (it happened) moves it into the sessions; × deletes one. Last in the run on purpose, like
  // the repeat check: the task ends up worked on.
  check('the planned check selects its task', await pick('Task 2') === 'ok')
  await page.evaluate(`document.querySelector('#insp #planadd').click()`)
  await settle()
  check('plan adds a stretch of two editable times',
    (await q(`!!document.querySelector('#insp #ps0') && !!document.querySelector('#insp #pe0') && !document.querySelector('#insp #ps1')`) as unknown as boolean) === true)
  await page.evaluate(`document.querySelector('#insp #planadd').click()`)
  await settle()
  await page.evaluate(`document.querySelector('#insp #px1').click()`)
  await settle()
  check('× deletes a stretch and leaves the other',
    (await q(`!!document.querySelector('#insp #ps0') && !document.querySelector('#insp #ps1')`) as unknown as boolean) === true)
  await page.evaluate(`document.querySelector('#insp #pd0').click()`)
  await settle()
  check('✓ says it happened: the stretch leaves the plan and becomes a session',
    (await q(`!document.querySelector('#insp #ps0') && !!document.querySelector('#insp #ss0')`) as unknown as boolean) === true)

  await page.screenshot({ path: '/tmp/playback-after-exit.png' })
  await b.close()
  const failed = results.filter(r => !r[1])
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  server.stop(true)
  process.exit(failed.length ? 1 : 0)
}
