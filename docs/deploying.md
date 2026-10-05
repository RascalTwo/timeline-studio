# Deploying

Timeline Studio runs in two places today: the homelab NAS (every publish, see the README)
and Source Allies AWS (by hand, for client plans). This page is what any host needs, and
how the AWS copy is wired, so a third host doesn't start from the git history.

## What a host needs

- **The `api` image** from the root `Dockerfile` (`--target api`). One process holds every
  open plan in memory, so run exactly one; a second would split a plan's editors between
  two rooms.
- **The page**, served from one origin with `/api/*` sent to the api. The `web` image does
  this with Caddy (`web/Caddyfile`). Any static host works if it serves the same files:
  `web/dist/`, `AGENTS.md`, `llms.txt` and the shared `*.js` that `web/` links to. Those
  shared files and `index.html` must be revalidated on every load (`no-cache`), because
  the bundle imports `/schedule.js` by a name that doesn't change with its contents
  ([ADR 0004](adr/0004-react-behind-a-bundler-shared-code-in-front-of-it.md)).
- **An S3-compatible bucket.** AWS S3 with a task role, or anything that speaks S3 via
  `S3_ENDPOINT` plus keys. Run `scripts/s3-conformance.mjs` against a new one first. The
  variables the server reads are in `sync-server/src/` (`grep -r process.env`).
- **A proxy that keeps WebSockets open.** The server pings every socket every 30 s
  (`PING_INTERVAL_MS`), so an idle timeout above that is enough.

Optional: setting `ECS_CLUSTER` turns on idle shutdown (`sync-server/src/idle-shutdown.ts`),
which scales the ECS service to zero when no plan is open. The page calls `/wake` before
its first request, so the host has to route that path to something that scales it back up.

## Schema upgrades happen on the host

The server upgrades a plan to the current schema the first time it opens it and writes
the result back, archiving the old draft to History first. A host that lags several
commits behind will upgrade its plans across every rung in between on the first open. Before
moving such a host forward, run its plans through `sync-server/src/upgrade.ts`
(`upgradePlan`) and `validate.ts` (`invalid`) offline.

## Example: AWS, from a private repo

The AWS template and scripts name an account, a role, domains and subnets, so they don't
live in this public repo. The pattern instead:

- A private repo holds only the host-specific half: the IaC and the deploy scripts.
- Its deploy job fetches this repo **at a pinned commit**, copies its own files over the
  checkout, and runs its deploy script. The pin is a CI variable; moving it and running
  the job is the whole release step.
- That job runs in the private repo, so the cloud account only has to trust the private
  repo's CI, not this one.
- `scripts/after-drop.sh` tags every publish. `main` is a single commit replaced on each
  publish, and without the tag an older pinned commit would disappear from the remote.

The Source Allies copy is built this way:

- S3 + CloudFront serve the page, and CloudFront sends `/api/*` to an ALB in front of
  one Fargate task.
- CloudFront routes `/wake` to a Lambda that sets the service back to one task.
- The ALB's target group health-checks the bare `/health` route (`sync-server/src/server.ts`).
