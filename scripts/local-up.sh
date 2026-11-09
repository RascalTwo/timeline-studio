#!/usr/bin/env bash
# Bring up the whole stack on this machine: a local S3 server (Versity Gateway), the sync
# server, and Vite.
#
# WHY THIS EXISTS. `s3.ts` has always said "set S3_ENDPOINT to a local S3 container
# so the entire data path runs offline", but nothing here started one, and
# `vite dev` did not work at all — `src/app.ts` imports `./schedule.js`, which is
# relative to `src/` while the symlinks are at `web/` root, so the page never
# loaded outside a build. Both are fixed; this script is the other half, so the
# offline path is a command rather than a paragraph someone reassembles.
#
# PORTS ARE NOT THE DEFAULTS, ON PURPOSE. 9000 is Cribl and 8080 is podman's
# gvproxy on at least one machine here, and a port collision shows up as a
# confusing 404 from the wrong service rather than a bind error. 5173 is every
# other Vite app's default, and one binding IPv4 while this binds IPv6 means
# `localhost` quietly serves whichever wins — hence 5190. Override any of them
# if yours differ.
set -euo pipefail

S3_PORT="${S3_PORT:-9002}"
SYNC_PORT="${SYNC_PORT:-8090}"
WEB_PORT="${WEB_PORT:-5190}"
BUCKET="${DATA_BUCKET:-timeline-studio-local}"
CONTAINER="${S3_CONTAINER:-ts-s3}"
# A REAL PATH ON A REAL DISK, not a named volume. A container-managed volume is
# one `podman volume prune` away from taking the plan with it, and the
# `.history/` snapshots live in the same place so they are no protection
# against exactly that. On a bind mount the data is an ordinary directory:
# Time Machine sees it, `cp` sees it, and nothing that cleans up containers can
# reach it.
# On a bind mount the data is also READABLE: Versity keeps each object as an ordinary file
# (`timeline-studio-local/data/<plan>.json`), metadata in extended attributes. Read it, but
# do not hand-edit it — the stored checksum goes stale and the sync server refuses that plan.
# Until 2026-10-04 this was MinIO, in `~/.timeline-studio/minio` (its own opaque format).
DATA_DIR="${TIMELINE_DATA_DIR:-$HOME/.timeline-studio/s3}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# THE SCHEDULED BACKUP RUNS A COPY, AND THIS IS WHY. A launchd agent cannot
# execute anything under `~/Desktop` — macOS TCC refuses with "Operation not
# permitted" and the job fails silently every night. So the nightly job points
# at `~/.timeline-studio/local-backup.sh`, and this refreshes that copy on every
# start so the two cannot drift apart. `scripts/local-backup.sh` stays the one
# you edit.
if [ -f "$here/scripts/local-backup.sh" ]; then
  mkdir -p "$(dirname "$DATA_DIR")"
  cp "$here/scripts/local-backup.sh" "$(dirname "$DATA_DIR")/local-backup.sh"
  chmod +x "$(dirname "$DATA_DIR")/local-backup.sh"
fi

docker_cmd="$(command -v docker || command -v podman || true)"
[ -n "$docker_cmd" ] || { echo "need docker or podman on PATH" >&2; exit 1; }

# VERSITY GATEWAY, PINNED BY DIGEST: an S3 API over a plain directory, the same server the NAS
# runs. It replaced MinIO, whose upstream stopped publishing images. The digest is the point: a
# `latest` that moves under a data directory is how a dev store stops opening. Bump it on
# purpose, after `node scripts/s3-conformance.mjs` passes against the new one.
S3_IMAGE="${S3_IMAGE:-versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499}"

# `--if-none-match '*'` is the one S3 feature this codebase genuinely depends on
# (`putIfAbsent` in s3.ts, which is how a plan id is claimed without a race).
# Do NOT point S3_ENDPOINT at some other S3-compatible server without running
# `scripts/s3-conformance.mjs` against it first — a silent wrong answer there means
# two plans can claim one id.
#
# No health route: an unsigned request answered 403 means it is up and speaking S3.
# The key pair is s3.ts's local default, so the sync server needs no credentials set.
s3_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${S3_PORT}/")" = 403 ]; }
if ! "$docker_cmd" ps --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -q .; then
  echo "starting Versity Gateway on :${S3_PORT}, data in ${DATA_DIR}"
  mkdir -p "$DATA_DIR"
  "$docker_cmd" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  "$docker_cmd" run -d --name "$CONTAINER" \
    -p "${S3_PORT}:7070" \
    -e ROOT_ACCESS_KEY_ID=minioadmin -e ROOT_SECRET_ACCESS_KEY=minioadmin \
    -v "${DATA_DIR}:/data" \
    "$S3_IMAGE" --quiet posix /data >/dev/null
else
  echo "Versity Gateway already running as ${CONTAINER}"
fi

for _ in $(seq 1 30); do
  s3_up && break
  sleep 1
done
s3_up || { echo "Versity Gateway did not come up on :${S3_PORT}" >&2; exit 1; }

export AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin AWS_REGION=us-east-1
aws --endpoint-url "http://localhost:${S3_PORT}" s3 mb "s3://${BUCKET}" 2>/dev/null \
  || echo "bucket ${BUCKET} already exists"

# THE SYNC SERVER AND THE PAGE ARE STARTED HERE TOO, detached, logs beside the data. This script
# used to only PRINT how, so "up" meant two more terminals. A port held by something that is NOT
# ours is a hard stop with the holder named, not a silent second server on a neighbouring port:
# the page would then talk to whichever answered first. Held by us already (the API answers, or
# the page serves) is fine — that is what makes a second run a no-op.
LOG_DIR="${DATA_DIR%/*}"
holder() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2")"}'; }
wait_for() { for _ in $(seq 1 "${3:-60}"); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done; echo "$2 did not come up — see ${LOG_DIR}/$2.log" >&2; return 1; }

if curl -sf -o /dev/null "http://localhost:${SYNC_PORT}/api/openapi.json"; then
  echo "sync server already running on :${SYNC_PORT}"
elif [ -n "$(holder "$SYNC_PORT")" ]; then
  echo "port ${SYNC_PORT} is held by $(holder "$SYNC_PORT"), not the sync server — free it or set SYNC_PORT" >&2; exit 1
else
  echo "starting the sync server on :${SYNC_PORT}"
  (cd "$here/sync-server" && DATA_BUCKET="$BUCKET" S3_ENDPOINT="http://localhost:${S3_PORT}" PORT="$SYNC_PORT" \
    nohup npm run dev >"${LOG_DIR}/sync-server.log" 2>&1 &)
  wait_for "http://localhost:${SYNC_PORT}/api/openapi.json" sync-server
fi

if curl -sf -o /dev/null "http://localhost:${WEB_PORT}/" && [ "$(holder "$WEB_PORT")" != "" ] \
   && curl -sf "http://localhost:${WEB_PORT}/" | grep -qi "timeline"; then
  echo "web UI already running on :${WEB_PORT}"
elif [ -n "$(holder "$WEB_PORT")" ]; then
  echo "port ${WEB_PORT} is held by $(holder "$WEB_PORT"), not the web UI (the viz skill's server has done this) — free it or set WEB_PORT" >&2; exit 1
else
  echo "building and starting the web UI on :${WEB_PORT}"
  # preview, not `npm run dev`: app.ts is one 400 kB module and the graph lens loads another 435 kB,
  # so unbundled a browser takes long enough to transform that the tab looks hung. HMR: `npm run dev`.
  (cd "$here/web" && nohup sh -c "npm run build && SYNC_PORT=${SYNC_PORT} npx vite preview --port ${WEB_PORT} --strictPort" \
    >"${LOG_DIR}/web-preview.log" 2>&1 &)
  wait_for "http://localhost:${WEB_PORT}/" web-preview 180
fi

# "UP" MEANS EVERY HEALTH CHECK PASSES, on every run, including a second run that started
# nothing. The web check goes through the page's own /api proxy, so it fails when the page and
# the sync server are not actually wired together, which two separate 200s would not catch.
unhealthy=0
check() { if "${@:2}" >/dev/null 2>&1; then echo "  ok    $1"; else echo "  FAIL  $1" >&2; unhealthy=1; fi; }
echo
echo "health:"
check "S3 (Versity)  :${S3_PORT}" s3_up
check "sync server   :${SYNC_PORT}" curl -sf "http://localhost:${SYNC_PORT}/api/health"
check "web page      :${WEB_PORT}" sh -c "curl -sf http://localhost:${WEB_PORT}/ | grep -qi timeline"
check "web -> sync   :${WEB_PORT}/api" sh -c "curl -sf http://localhost:${WEB_PORT}/api/health | grep -q '\"ok\":true'"
[ "$unhealthy" = 0 ] || { echo "the stack is not healthy — see the logs in ${LOG_DIR}" >&2; exit 1; }

cat <<EOF

S3         http://localhost:${S3_PORT}   (Versity Gateway, minioadmin/minioadmin)
sync       http://localhost:${SYNC_PORT}   (log ${LOG_DIR}/sync-server.log)
web        http://localhost:${WEB_PORT}   (log ${LOG_DIR}/web-preview.log)
bucket     ${BUCKET}
data       ${DATA_DIR}/${BUCKET}   (plain files: read, never hand-edit)
backups    ${DATA_DIR%/*}/backups   (scripts/local-backup.sh takes one)

Stop the two servers with: kill \$(lsof -nP -iTCP:${SYNC_PORT} -iTCP:${WEB_PORT} -sTCP:LISTEN -t)

Create a plan and open it:

  curl -s -X POST http://localhost:${SYNC_PORT}/api/plan/new \\
    -H 'content-type: application/json' -d '{"title":"My plan"}'
  # -> {"ok":true,"id":"my-plan","shareToken":"<token>"}
  # open http://localhost:${WEB_PORT}/#<token>
EOF
