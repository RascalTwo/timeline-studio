#!/usr/bin/env bash
# Snapshot every plan out of the local S3 server (Versity Gateway) into a dated folder.
#
# WHY THIS EXISTS EVEN THOUGH THE DATA IS ALREADY ON DISK. `local-up.sh` bind-
# mounts a real directory, so the plans survive anything that cleans up
# containers, and Versity keeps it as readable files — but their metadata is in
# extended attributes that a plain copy drops, and copying under a running server
# can catch a write half-way. This reads the bucket through the S3 API instead,
# which is the format the server would restore from: `data/<plan>.json` is the
# whole plan.
#
# It also protects against the failure a bind mount does not: a bad edit. The
# `.history/` snapshots are per-plan and live in the same bucket, so a corrupted
# or emptied bucket takes them too.
#
# Keeps the last N runs and deletes the rest, because a backup that fills the
# disk stops being a backup.
set -euo pipefail

S3_PORT="${S3_PORT:-9002}"
BUCKET="${DATA_BUCKET:-timeline-studio-local}"
DEST="${TIMELINE_BACKUP_DIR:-$HOME/.timeline-studio/backups}"
KEEP="${TIMELINE_BACKUP_KEEP:-14}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-minioadmin}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-minioadmin}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

# No health route: an unsigned request answered 403 means it is up and speaking S3.
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${S3_PORT}/")" = 403 ] || {
  echo "the local S3 server is not up on :${S3_PORT} — nothing to back up" >&2; exit 1; }

stamp="$(date +%Y-%m-%d_%H%M%S)"
out="$DEST/$stamp"
mkdir -p "$out"
aws --endpoint-url "http://localhost:${S3_PORT}" s3 sync "s3://${BUCKET}" "$out" --quiet

plans="$(ls "$out/data" 2>/dev/null | wc -l | tr -d ' ')"
[ "$plans" -gt 0 ] || { echo "backed up 0 plans — refusing to keep an empty snapshot" >&2; rm -rf "$out"; exit 1; }

# Newest first, drop everything past $KEEP. `ls -1` on dated names sorts
# lexicographically, which for this stamp format is chronological.
( cd "$DEST" && ls -1 | sort -r | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do rm -rf -- "$old"; done )

echo "$plans plan(s) -> $out   ($(ls -1 "$DEST" | wc -l | tr -d ' ') snapshots kept)"
