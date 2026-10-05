# Project Instructions

## Branch model — private trunk, single-commit public drop

`private/trunk` is the working branch and holds the real history. It is
**local-only — never push it.** `main` is a disposable public mirror: it only ever holds
**one parentless commit** that private/trunk's whole tree is squashed into and
force-pushed. So on the remote there is only ever a single commit.

**Whenever changes should be "pushed" (you say push, or an agent would otherwise push):**
1. Commit to `private/trunk` as normal.
2. Run `./squash-to-main.sh` — squashes private/trunk's tree into one orphan commit on
   `main` and force-pushes it.

A **pre-push hook** (`.git/hooks/pre-push`, per-clone, installed by `scripts/install-hooks.sh`)
refuses any ref under `private/` and any pushed commit with a parent, and turns a trunk
push into a `squash-to-main.sh` run. The `failed to push some refs` git prints after that is
deliberate. `.git/hooks` is not version controlled: run `scripts/install-hooks.sh` once on
every fresh clone, which also installs the pre-commit check gate.

Because only the tree is ever public, anything committed to `private/trunk` that should
not be public has to be out of the TREE before the next drop. Commit messages and history
never leave the machine, and the drop's own message carries only a date.

## The check gate

`scripts/check-gate.sh` runs `npm run check` (sync-server tests, the browser suite, the
shared-code parity check) and compares the red against `scripts/known-red.txt`. The pre-commit
hook runs it, so a commit that touches anything but markdown takes ~90s. Override with
`git commit --no-verify`. `AGENTS.md` has the details.

## Deploying

A publish (`./squash-to-main.sh`) IS a deploy: CI runs the tests (`check`) while `build`
builds the `Dockerfile`'s `api` and `web` images to ghcr.io as `sha-<commit>` tags; once
both are green, `release` moves `:latest` to those digests and signals the homelab NAS, which
pulls and redeploys them within a second (RascalTwo/homelab, `nas-apps/deployer`). End to end
is about 2.5 minutes, with `check` the long pole. The publish is skipped when nothing
the images are built from changed (`sync-server/`, `web/`, `shared/`, `scripts/`, `Dockerfile`,
`.dockerignore`): CI compares a hash of those trees with the label on the image the NAS is
running (the `gate` step in `ci.yml`). A docs-only drop therefore tests but deploys nothing;
run the workflow by hand (`workflow_dispatch`) to force a deploy.

A second copy runs on Source Allies AWS for client plans, deployed from
`sourceallies/sai-jm-snippets` (`timeline-studio/`), which pins a commit of this repo in
its `TIMELINE_STUDIO_REF` variable. A publish here does not move it. See
[`docs/deploying.md`](docs/deploying.md).

## No real plan data in this repo

Plans are someone's real delivery schedule and never live here. The only plan checked in
is the invented bakery demo fixture (`web/demo-plan.json`). Running the tests must never
touch a live server or its data: the suites use their own ports and no storage.

## Git staging

Stage specific files by name — never `git add -A` / `git add .`.
