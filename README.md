# timeline-studio

A delivery-plan chart where a team edits one plan together in real time. Bars are tasks,
lanes are teams, and the dates are computed rather than stored — move one thing and the
rest reflows.

Every push to `main` deploys it to a personal home server (the homelab NAS, at
`timeline-studio.rascaltwo.com`); locally it runs with `scripts/local-up.sh`. A plan is reached by its
share link — `#<token>` on the end of the server's URL — and by nothing else: there is no
listing page and no login. The single-writer tool it grew out of has been deleted; what
outlived it is in [`docs/original/`](docs/original/) — the two documents that are still this
tool's specification, and the two harnesses that cover the scheduler and the page.

**Deploying.** The root `Dockerfile` builds two images from one build stage: `api` (the sync
server, the same image on every target) and `web` (the page behind Caddy, `web/Caddyfile`,
for hosts without CloudFront + S3 in front). CI publishes both to ghcr.io and sends a signed
notice that the NAS acts on; how the NAS side works lives in RascalTwo/homelab
(`nas-apps/timeline-studio`, `nas-apps/deployer`). The AWS deployment this was built for (SAM
stack, deploy scripts, smoke test) was left behind when the repo was extracted; it is in the
git history, and bringing it back is a separate piece of work.

## Reading order

The original tool's own docs are the specification for everything except sync. They were
never duplicated here, so when that tool was deleted they moved here rather than dying
with it:

- **[`docs/original/README.md`](docs/original/README.md)** — the design rationale. Why
  arrow dashes mean distance, why undo was removed, why the scheduler runs in the browser.
- **[`docs/original/AGENTS.md`](docs/original/AGENTS.md)** — the document schema and the
  HTTP surface. This is the reference for anything writing a plan programmatically.
- **`docs/original/verify.sched.mjs`** — the scheduler harness, and the only thing that
  tests `suggestReorders` and `laneOrder`. It ran nowhere for a while: it still named
  `index.html` and `./schedule.js`, which are now `web/` and `shared/`. Repointed, and it
  is now the last step of `npm test`, so it fails the deploy rather than rotting quietly.
  `sync-server/test/` covers the room, not the dates.
- **`scripts/playback-harness.ts`** — the browser suite: the real page in headless
  Chrome against a stub API, on no infrastructure, and CI runs it before every
  deploy. It replaced `docs/original/verify.interactions.ts`, which needed a live
  server and the viz skill's driver and therefore never joined an automated run —
  a suite nobody runs reads as coverage, so it has been deleted. The one thing it
  uniquely covered, the migrator over a synthetic ladder, is
  `sync-server/test/migrations.test.ts`.
- **`docs/adr/`** here — the decisions this rebuild adds. Start with
  [0001](docs/adr/0001-server-authoritative-command-log.md) (why a command log and not a
  CRDT) and [0002](docs/adr/0002-capability-tokens-no-sso.md) (why a link is the only
  thing guarding a client's delivery schedule).

## Shape

Copied from `private-tldraw`, which solved this deployment already: a single Fargate task
holding all rooms in memory behind an ALB, S3 for persistence, and scale-to-zero when idle.

| | |
|---|---|
| `web/` | the page — one HTML file, no bundler, plus `demo-plan.json` (the demo's tracked starting state) |
| `sync-server/` | command room, S3 persistence, idle shutdown |
| `shared/` | `commands.js` and `schedule.js` — protocol and scheduler, one copy, run by both sides |
| `AGENTS.md` | working on the TOOL, for an agent in this repo. `web/AGENTS.md` is the other audience — driving a PLAN over HTTP, served at `/AGENTS.md` |
| `scripts/` | migration, local harness, `reset-demo.sh`, `nuke-plan.sh`, `playback-harness.ts` |

## Data never lives in this repo

Plans are a client's real delivery schedule. They live in S3, and locally in a Versity
Gateway (`scripts/local-up.sh`) seeded from a backup. Nothing in `web/` beyond the invented demo seed (`web/demo-plan.json`) describes a
real plan, and it stays that way — this repo is published.
