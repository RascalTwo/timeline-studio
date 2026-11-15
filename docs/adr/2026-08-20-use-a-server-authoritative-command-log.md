# Use a server-authoritative command log, not a CRDT

Status: Accepted, 2026-08-20

## Context and Problem Statement

timeline-studio needs real-time multiplayer. The obvious choice is a CRDT (Yjs, Automerge). It is mature and well understood, and the sibling `private-tldraw` gets one almost for free from `@tldraw/sync-core`.

Array position in `tasks` is a scheduling input. A lane is a serial queue and array position is queue position, so the order of `tasks` decides dates. The tool's own `AGENTS.md` puts it bluntly: a plan can be 32 days wrong with every duration and dependency correct.

CRDTs merge states. Two concurrent reorders merge into an interleaving neither person chose. Unlike garbled text, the result looks plausible and produces a different finish date.

A second problem: a CRDT has no save, so it has no note. History would degrade from documents a human annotated into an op log nobody reads. The Save-with-a-note discipline is load-bearing for this tool.

The scheduler adds a standing hazard. `schedule.js` is imported by the page and by the server. In the original tool both read the same file on one machine, and `api.ts` re-imported it per call with a cache bust to prevent "the backend and the chart quietly disagreeing about a date". Hosted, that guarantee is gone. The page loads `schedule.js` from S3, the server has its own copy in a container image, the two ship down different pipelines at different times, and a stale copy still computes a date, so the failure is silent.

## Decision

A server-authoritative command log. Clients send semantic commands. The server assigns sequence numbers, validates, applies and broadcasts. No CRDT.

A command log serializes intents. Bob's move applies, then Alice's applies to the result. That is what happens in a room, and it is recoverable.

**Every mutation must be a command, with no exceptions.** This is the same structural requirement that killed undo in the original tool: a snapshot at 28 mutation sites, where missing one broke it silently. The mitigation is a `Proxy` around `doc` that throws on any direct write outside a command applier, so a missed site fails loudly on the first click. Without that guard this decision is worse than a CRDT. The guard is browser-side, because that is where the 28 sites are. The server has exactly one write site and swaps in a fresh document rather than mutating one.

The command log is transport, not storage. It is a bounded ring buffer for reconnect replay. The server applies commands on arrival, so the live document is always current and nothing needs replaying at save time.

Document-level scalars (title, start, sprint, workweek) go through one generic `patchDoc` command rather than eighteen named ones. It is still a command and still guarded.

### One copy of the scheduler, checked against the running server

`schedule.js` lives in `shared/` beside `commands.js`. There is one copy in the repo. The web deploy uploads it to the bucket root and the Dockerfile copies it into the image (the Dockerfile takes `shared/` and deliberately does not take `web/`).

Comparing the repo's copies cannot catch the real bug. A web-only deploy pushes a new `schedule.js` to S3 while the backend still serves the previous image, and a backend rollback does the reverse. The repo has one copy, a byte-diff passes, and production is skewed.

So the parity check compares against the running server, which reports the hash of the file it imported at startup. The hash is computed at startup from the file on disk in the image. It is never injected by a build step, which could only confirm what the build believed rather than what the server loaded.

The check is fail-closed with three outcomes: matched, differing, and could not tell. "Could not tell" fails. A server scaled to zero, or one that predates this contract, must never read as agreement.

### The symlinks in `web/` are the manifest

`web/schedule.js` and `web/commands.js` are symlinks into `shared/`. They look like clutter. They decide what the parity gate covers. Removing one breaks local dev and silently drops that file from the gate.

The derivation follows from facts that were already true. The Dockerfile does `COPY shared /app/shared`, so the image has everything in `shared/`. The bucket gets only what `web/` exposes. The page can import a shared file only if `web/` links to it, and `web/` must link it anyway to be servable on its own. So a file ships to both places exactly when `web/` symlinks to it, and the step needed for local dev is the step that enrols it in the gate. A server-only shared file cannot drift, so it is correctly ignored. (The example was `shared/recipes-as-commands.ts`, a manual port-era check deleted on 2026-09-26.)

`/health` therefore reports a per-file map:

```
{"ok": true, "shared": {"schedule.js": "<64hex>", "commands.js": "<64hex>"}}
```

A rollup digest cannot express this check. The two sides cover different sets: the image carries all of `shared/` including server-only files, and the bucket carries only what `web/` symlinks. A digest over every shared file can never equal a digest over the shipped ones once a server-only `.js` exists. So the comparison is a per-file subset check. A rollup looks like the cheap path: someone optimises onto it, gets a check that fails constantly, and silences it. The full argument is in the header of `scripts/assert-shared-parity.sh`, where that change would be made.

Being a subset check, it allows the server to report server-only shared code the bucket never gets. A file the server fails to report is a failure, and so is an empty manifest. A gate that passes because it found nothing to check protects nothing.

A map also says which file drifted. A commands drift is worse than a scheduler drift: a scheduler drift makes dates disagree, which a human might catch, while a commands drift means client and server disagree about what an edit means and nothing errors at all.

If the parity check is ever removed, this ADR's premise (the server and the page schedule identically) stops being true.

## Alternatives Considered

- Yjs with array order held as a last-write-wins register: a real hybrid that keeps field-level merging and makes reorder atomic. Rejected because once the server is authoritative and sequencing anyway, the CRDT stops earning its complexity.
- Optimistic concurrency only (version number, 409 on conflict): planned as an interim step, a strict prefix of this decision. It was never built. The command log landed directly and there is no 409 anywhere in the server. The option remains if this is ever unwound.
- Comparing the repo's copies of the scheduler, or a single rollup digest: rejected for the reasons above.

## More Information

- Code: `shared/commands.ts`, `sync-server/src/room.ts`, `sync-server/src/shared-hash.ts`, `scripts/assert-shared-parity.sh`.
- Rewritten 2026-11-13 from ADR 0001; alternatives reconstructed from code and history where the original did not record them.
