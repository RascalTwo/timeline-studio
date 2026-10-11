#!/usr/bin/env bash
#
# Assert that every shared file the browser will run is byte-identical to the one
# the server is running. Exits non-zero if any differ, or if it cannot tell.
#
# WHY (ADR 0001)
# --------------
# `shared/` holds the files both sides must agree on — the scheduler, the command
# protocol. They reach production down two different pipelines: the web deploy
# uploads them to the bucket, the Docker build copies `shared/` into the image.
# Nothing forces the two to arrive together. A web-only deploy ships a new file
# to S3 while the task still serves the old one, and the disagreement is silent:
# a stale scheduler still computes *a* date, a stale protocol still parses *a*
# command and quietly means something else by it.
#
# THE SET IS DERIVED, NEVER ENUMERATED
# ------------------------------------
# A hardcoded list of two is a list someone forgets to append to — and a gate
# that implies coverage it does not have is worse than no gate. So the set is
# computed: a file ships to BOTH places exactly when `web/` symlinks to it in
# `shared/`.
#
# That is not a convention this script invents, it is already true for an
# independent reason. The Dockerfile takes all of `shared/`, so the image has
# everything. The bucket gets only what `web/` exposes. And the page can only
# import a shared file if `web/` links to it — which it must anyway, or serving
# `web/` locally breaks. So the symlink IS the manifest: add a third shared file
# the page needs, symlink it so local dev works, and it is covered here with
# nobody remembering to say so. A shared file the SERVER alone uses is not
# symlinked, never reaches the bucket, cannot drift, and is correctly ignored.
#
# CONTRACT REQUIRED FROM sync-server
#   GET /health -> 200 {"ok": true, "shared": {"<name>": "<64 lowercase hex>", ...}}
# keyed by filename relative to shared/, hashed at startup from the files on disk
# in the image — never injected by a build step, which could only confirm what
# the build believed rather than what the server loaded.
#
# SUBSET, and that is why the map is consumed rather than a rollup digest. The
# image carries ALL of shared/, including server-only files that never reach the
# bucket; the bucket carries only what web/ symlinks. So the two sides legitimately
# cover different sets, and a digest over "all shared files" could never equal a
# digest over "the shipped ones". Every file THIS script ships must match; extra
# entries on the server are expected and ignored. Do not "simplify" this into a
# single-digest comparison — it cannot be made to work.
#
# USAGE
#   scripts/assert-shared-parity.sh --api-base https://timeline-studio.example.com
#   scripts/assert-shared-parity.sh --repo-only          # pre-deploy, no server yet
#   scripts/assert-shared-parity.sh --api-base <url> --bucket <web-bucket>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_BASE=""; BUCKET=""; REPO_ONLY=0; LIST_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --api-base) API_BASE="$2"; shift 2 ;;
    --bucket)   BUCKET="$2";   shift 2 ;;
    --repo-only) REPO_ONLY=1;  shift ;;
    # Print the derived manifest as "<name>\t<sha256>" and stop. Exists so the
    # deploy can ask WHICH files are shared without re-deriving the rule — one
    # place decides what is covered, which is the entire point of deriving it.
    --list)     LIST_ONLY=1;   shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "SHARED PARITY: $*" >&2; exit 1; }
command -v python3 >/dev/null || die "python3 is required (JSON and digests)"

# --- 1. derive the manifest --------------------------------------------------
MANIFEST="$(python3 - "$REPO_ROOT" <<'PY'
import hashlib, pathlib, sys
repo = pathlib.Path(sys.argv[1])
shared = (repo / 'shared').resolve()
web = repo / 'web'
rows = []
for p in sorted(web.iterdir()) if web.is_dir() else []:
    if not p.is_symlink():
        continue
    t = p.resolve()               # follows the link
    if shared not in t.parents:   # a link pointing elsewhere is not our business
        continue
    if not t.is_file():
        rows.append(f"DANGLING\t{p.name}\t{t}")
        continue
    rows.append(f"OK\t{t.relative_to(shared)}\t{hashlib.sha256(t.read_bytes()).hexdigest()}")
print("\n".join(rows))
PY
)"

DANGLING="$(printf '%s\n' "$MANIFEST" | grep '^DANGLING' || true)"
[ -z "$DANGLING" ] || die "web/ has symlinks into shared/ whose targets are gone, so the
page cannot load them and nothing can be compared. Restore the files or fix the links:
$(printf '%s\n' "$DANGLING" | awk -F'\t' '{print "  web/"$2" -> "$3}')"

FILES="$(printf '%s\n' "$MANIFEST" | awk -F'\t' '$1=="OK"{print $2"\t"$3}' | grep . || true)"
# An empty manifest is not "nothing to check" — it is what a broken setup looks
# like, and passing here is precisely the silent loss of coverage this exists to
# refuse. If the page genuinely shares nothing, delete this script deliberately.
[ -n "$FILES" ] || die "web/ symlinks nothing into shared/, so this gate is protecting
nothing. Either the symlinks were lost (local dev is broken too) or the page no
longer imports shared code and this check should be removed on purpose."

if [ "$LIST_ONLY" = 1 ]; then printf '%s\n' "$FILES"; exit 0; fi

echo "shared files shipping to both the bucket and the image:"
printf '%s\n' "$FILES" | awk -F'\t' '{printf "  %-16s %s\n", $1, $2}'

# --- 2. exactly one copy of each ---------------------------------------------
# A symlink cannot drift; a `cp` can. Regular files only, so web/'s links pass
# and `cp shared/commands.js sync-server/` does not.
while IFS="$(printf '\t')" read -r NAME _; do
  [ -n "$NAME" ] || continue
  DUPES="$(/usr/bin/find "$REPO_ROOT" -name "$NAME" -type f \
            -not -path "$REPO_ROOT/shared/*" -not -path '*/node_modules/*' 2>/dev/null || true)"
  [ -z "$DUPES" ] || die "$NAME has a second real copy outside shared/. There must be exactly
one, imported by both sides, or the two can drift apart silently:
$(printf '%s\n' "$DUPES" | sed 's/^/  /')"
done <<EOF
$FILES
EOF

if [ "$REPO_ONLY" = 1 ]; then
  echo "OK (repo-only: one copy of each, runtime comparison skipped by request)"
  exit 0
fi
[ -n "$API_BASE" ] || die "--api-base is required (or --repo-only to check the repo alone)"

# --- 3. the comparison that matters ------------------------------------------
HEALTH="$(curl -fsS --max-time 15 "$API_BASE/health" 2>/dev/null || true)"
[ -n "$HEALTH" ] || die "could not reach $API_BASE/health -- refusing to guess.
If the service is scaled to zero, wake it first; a sleeping server is not a matching one."

REPORT="$(printf '%s' "$HEALTH" | python3 -c '
import json, sys
health_raw = sys.stdin.read()
manifest = [l.split("\t") for l in sys.argv[1].splitlines() if l.strip()]
try:
    got = json.loads(health_raw).get("shared")
except Exception:
    # A CloudFront host serves the page for anything outside /api/*, so the most
    # likely cause is the wrong base URL rather than a broken server. Say so.
    if health_raw.lstrip()[:1] == "<":
        print("BAD\t/health returned HTML, not JSON. That is the static site answering: "
              "the API is only reachable under /api/* through CloudFront. Pass the ALB "
              "origin -- the ApiOriginUrl output of the compute stack -- or append /api.")
    else:
        print("BAD\t/health did not return JSON")
    raise SystemExit
if not isinstance(got, dict):
    print("BAD\t/health did not report a `shared` MAP. The server predates the "
          "ADR 0001 parity contract, so nothing here can verify that the page and "
          "the server agree."); raise SystemExit
bad = []
for name, want in manifest:
    have = got.get(name)
    if have is None:
        bad.append(f"MISSING\t{name}\tthe server does not report this file at all")
    elif have != want:
        bad.append(f"DIFFERS\t{name}\tpage {want}  server {have}")
for b in bad:
    print(b)
' "$FILES")"

if [ -n "$REPORT" ]; then
  case "$REPORT" in
    BAD*) die "$(printf '%s' "$REPORT" | cut -f2-)
Response was:
$HEALTH" ;;
  esac
  die "THE PAGE AND THE SERVER DISAGREE ABOUT SHARED CODE.
$(printf '%s\n' "$REPORT" | awk -F'\t' '{printf "  %-8s %-16s %s\n", $1, $2, $3}')
Per ADR 0001 this is silent in production: a stale scheduler still computes a
date, a stale protocol still parses a command and means something else by it.
Deploy the backend and the web bundle together, then re-run."
fi
echo "  ✓ server agrees on every one"

# --- 4. optional: prove the bytes reached the bucket -------------------------
if [ -n "$BUCKET" ]; then
  while IFS="$(printf '\t')" read -r NAME WANT; do
    [ -n "$NAME" ] || continue
    S3="$(aws s3 cp "s3://$BUCKET/$NAME" - 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)"
    [ -n "$S3" ] || die "could not read s3://$BUCKET/$NAME -- refusing to guess"
    [ "$S3" = "$WANT" ] || die "the bucket copy of $NAME differs from shared/$NAME, so the
web upload did not land.
  local:  $WANT
  bucket: $S3"
  done <<EOF
$FILES
EOF
  echo "  ✓ bucket matches too"
fi

echo "OK: page, server$([ -n "$BUCKET" ] && echo ', bucket') agree on all shared code."
