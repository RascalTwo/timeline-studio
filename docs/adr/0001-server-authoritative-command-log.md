# ADR 0001 — Server-authoritative command log, not a CRDT

**Status:** accepted, 2026-08-20

## Context

timeline-studio needs real-time multiplayer. The obvious choice is a CRDT (Yjs,
Automerge) — mature, well-understood, and it's what the sibling `private-tldraw`
effectively gets for free from `@tldraw/sync-core`.

## Decision

A server-authoritative command log. Clients send semantic commands; the server assigns
sequence numbers, validates, applies, and broadcasts. No CRDT.

## Why

**Array position in `tasks` is a scheduling input.** A lane is a serial queue and array
position is queue position, so the order of `tasks` decides dates. The tool's own
`AGENTS.md` puts it bluntly: a plan can be 32 days wrong with every duration and
dependency correct.

CRDTs merge *states*. Two concurrent reorders merge into an interleaving neither person
chose — and unlike garbled text, the result looks completely plausible while producing a
different finish date. A command log serializes *intents*: Bob's move applies, then
Alice's applies to the result. That is what happens in a room, and it is recoverable.

Secondary: a CRDT has no save, so it has no note, so History degrades from documents a
human annotated into an op log nobody reads. The Save-with-a-note discipline is load-
bearing for this tool.

## Consequences

**Every mutation must be a command, with no exceptions.** This is the same structural
requirement that killed undo in the original tool — a snapshot at 28 mutation sites, where
missing one broke it silently. The mitigation is a `Proxy` around `doc` that throws on any
direct write outside a command applier, so a missed site fails loudly on the first click.
Without that guard this decision is worse than a CRDT. It is a **browser-side** guard,
because that is where the 28 sites are; the server has exactly one write site and swaps in
a fresh document rather than mutating one.

The command log is transport, not storage — a bounded ring buffer for reconnect replay.
The server applies commands on arrival, so the live document is always current and nothing
needs replaying at save time.

Document-level scalars (title, start, sprint, workweek) go through one generic `patchDoc`
command rather than eighteen named ones. Still a command; still guarded.

## The scheduler is now in two artifacts, and that is a standing hazard

`schedule.js` is imported by the page *and* by the server. In the original tool both read
the same file on one machine, and `api.ts` went out of its way to re-import it per call
with a cache bust — its comment says the failure mode it was built to prevent is "the
backend and the chart quietly disagreeing about a date, which is precisely what the chart
exists to prevent."

Hosted, that guarantee is gone. The page loads `schedule.js` from S3; the server has its
own copy baked into a container image. Two artifacts, deployed by two different paths,
with nothing forcing them to match — and the failure is silent, because a stale copy
still computes *a* date.

`schedule.js` therefore lives in `shared/`, beside `commands.js` — the same argument that
put the protocol there. One copy in the repo, uploaded to the bucket root by the web
deploy and copied into the image by the Dockerfile, which already takes `shared/` and
deliberately does not take `web/`.

**But comparing the repo's copies is structurally incapable of catching the real bug.**
One file in the repo does not mean one file in production, because the two artifacts ship
down two pipelines that run at different times. A web-only deploy pushes a new
`schedule.js` to S3 while the backend still serves the previous image; a backend rollback
does it in reverse. In both cases the repo has exactly one copy, a byte-diff passes, and
production is skewed.

**So the parity check compares against the running server**, which reports the hash of the
file it actually imported at startup:

```
GET /health -> 200 {"ok": true, "scheduleSha256": "<64 lowercase hex>"}
```

Computed at startup from the file on disk in the image — never injected by a build step,
which could only ever confirm what the build believed rather than what the server loaded.

The check is fail-closed with **three** outcomes, not two: matched, differing, and *could
not tell*. The last one fails. A server that is scaled to zero, or that predates this
contract, must never read as agreement — that is the shape in which this check would
quietly stop protecting anything.

If it is ever removed, this ADR's premise — that the server and the page schedule
identically — stops being true, and the failure is silent because a stale copy still
computes *a* date.

### The symlink in `web/` is the manifest. Do not tidy it away.

`web/schedule.js` and `web/commands.js` are symlinks into `shared/`. They look like
clutter. They are the thing that decides what the parity gate covers, and removing one
breaks local dev *and* silently drops that file from the gate — with nothing failing.

The derivation is forced by facts that were already true, not a convention someone
invented:

- The Dockerfile does `COPY shared /app/shared`, so the **image has everything** in
  `shared/`.
- The bucket gets only what `web/` exposes.
- The page can only import a shared file if `web/` links to it — **and it must be linked
  anyway, or `web/` stops being servable on its own.**

So a file ships to both places exactly when `web/` symlinks to it. The step you have to
take for local dev is the step that enrols it in the gate; there is no separate list to
remember to append to. Add a third shared file the page needs, symlink it so you can serve
`web/` locally, and it is covered by nobody's decision.

It handles the negative case too, which is what makes it trustworthy rather than merely
clever: a shared file that is server-only — never symlinked, never in the bucket — cannot
drift, so it is correctly ignored rather than gated against a file the bucket will never
have. (The example here was `shared/recipes-as-commands.ts`, a manual port-era check
deleted on 2026-09-26: it needed the original tool's checkout and nothing ran it.)

`/health` therefore reports a **per-file map**:

```
{"ok": true, "shared": {"schedule.js": "<64hex>", "commands.js": "<64hex>"}}
```

**A rollup digest cannot express this check, and that is a fact rather than a preference.**
The two sides legitimately cover *different sets*: the image carries all of `shared/`
including server-only files, the bucket carries only what `web/` symlinks. A digest over
"every shared file" can never equal a digest over "the shipped ones" the moment a
server-only `.js` exists — and one will. So the comparison has to be a per-file subset
check. A rollup is worse than useless because it *looks* like the cheap path: someone
optimises onto it, gets a check that fails constantly, and silences it. The full argument
lives in `scripts/assert-shared-parity.sh`'s header, where that change would be made.

Being a subset check, the server legitimately reports server-only shared code the bucket
never gets. But **a file the server fails to report is a failure, not a pass**, and an
empty manifest is a failure too. A gate that passes because it found nothing to check is
the exact shape of a gate protecting nothing.

A map also distinguishes *which* file drifted, and "the protocol drifted" and "the
scheduler drifted" want different responses.

A commands drift is the worse of the two. A scheduler drift makes the dates disagree, which
is at least a number a human might catch. A commands drift means the client and server
disagree about what an edit *means* — a field present on one side and absent on the other —
and nothing errors at all.

## Rejected alternatives

**Yjs with array order held as a last-write-wins register** — a real hybrid that keeps
field-level merging and makes reorder atomic. Rejected because once the server is
authoritative and sequencing anyway, the CRDT stops earning its complexity.

**Optimistic concurrency only** (version number, 409 on conflict). Planned as an interim
step — a strict prefix of this, shipping first to get people access. It was never built:
the command log landed directly and there is no 409 anywhere in the server. Noted because
the option is still there if this is ever unwound, not because anything is pending.
