#!/usr/bin/env bash
#
# PERMANENTLY DESTROY ONE PLAN AND ITS ENTIRE ARCHIVE.
#
# NEEDS AWS CREDENTIALS, AND IS DELIBERATELY NOT AN ENDPOINT. Same reasoning as
# list-plans.sh: a capability token is authorisation to EDIT a plan, and edits are
# recoverable — every one is a command in a log, and /api/revert puts any of them
# back. Destruction is not recoverable, so it must not be reachable by anything a
# share link can do. The auth for this is an operator's own AWS credentials, held
# on a laptop, and nothing in the server can do what this script does. Nothing in
# the server should be taught to.
#
# THIS IS THE ONE THING THE SAFEGUARDS EXIST TO PREVENT. The README is explicit:
# plans are protected by DeletionPolicy: Retain, plus bucket versioning, plus a
# task role that cannot delete a version. This script steps around all three on
# purpose, which is why it refuses far more than it accepts:
#
#   * DRY RUN BY DEFAULT. It prints what it would destroy and stops. `--yes` runs.
#   * SCRATCH ONLY BY DEFAULT. A plan whose title does not start with "SCRATCH"
#     is refused; `--force` overrides, and then it makes you type the id back.
#   * NEVER THE DEMO. `demo-bakery` is refused outright — reset-demo.sh is how
#     you fix that one, and it is the only plan a stranger is invited to break.
#   * ONE ID PER RUN. No globs, no prefixes, no `--all`. Whatever you would build
#     that on top of, do not.
#
# It removes EVERY VERSION of every key, because the bucket is versioned and a
# delete marker is not a deletion — the plan would still be readable by anyone
# who could list versions, which is exactly the false sense of security this
# script must not create.
#
#   ./scripts/nuke-plan.sh scratch-interaction-suite-...          # dry run
#   ./scripts/nuke-plan.sh scratch-interaction-suite-... --yes    # do it
#   ./scripts/nuke-plan.sh some-other-plan --yes --force          # and type the id
#
# Exercised 2026-09-02 against the live dev bucket: six scratch plans destroyed,
# 67 object versions, nothing left under any of the four prefixes and no delete
# markers. Pointed at the real client plan with --yes it refused, and that plan
# still had all 75 of its versions afterwards.
#
# Find ids with ./scripts/list-plans.sh. That script prints live share tokens;
# this one never does, because a token in a terminal you are about to paste into
# a ticket is the failure mode list-plans.sh spends a paragraph warning about.
set -euo pipefail

ID="${1:-}"; shift || true
DO_IT=""; FORCE=""
for a in "$@"; do
  case "$a" in
    --yes)   DO_IT=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

[ -n "$ID" ] || { sed -n '3,37p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
# Ids become object keys. A slash or a `..` here would reach outside the plan's
# own prefix, and this script deletes every version of what it is pointed at.
case "$ID" in
  *[!a-zA-Z0-9-]*|"") echo "refusing: '$ID' is not a plan id (letters, digits, hyphens)" >&2; exit 2 ;;
esac
[ "$ID" != "demo-bakery" ] || {
  echo "refusing: demo-bakery is the shared demo. Use ./scripts/reset-demo.sh to put it right." >&2; exit 2; }

BUCKET="${DATA_BUCKET:-}"
if [ -z "$BUCKET" ]; then
  BUCKET="$(aws cloudformation describe-stacks --stack-name timeline-studio \
    --query "Stacks[0].Outputs[?OutputKey=='DataBucketName'].OutputValue" --output text 2>/dev/null || true)"
fi
[ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] || {
  echo "no bucket: set DATA_BUCKET, or get credentials that can read the timeline-studio stack" >&2; exit 1; }

aws_s3() { aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} "$@"; }

# WHAT IT IS, BEFORE DECIDING WHETHER IT MAY DIE. Read the title from the live
# plan object rather than trusting the id to look scratch-shaped: the id is
# derived from the title at creation and can be edited apart from it afterwards.
TITLE="$(aws_s3 s3 cp "s3://$BUCKET/data/$ID.json" - 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("title",""))' 2>/dev/null || true)"
[ -n "$TITLE" ] || { echo "no such plan: data/$ID.json is not in s3://$BUCKET" >&2; exit 1; }

case "$TITLE" in
  SCRATCH*) ;;
  *) if [ -z "$FORCE" ]; then
       echo "refusing: \"$TITLE\" is not a SCRATCH plan." >&2
       echo "  This is somebody's real delivery schedule until proven otherwise." >&2
       echo "  If you are certain, re-run with --force and type the id when asked." >&2
       exit 2
     fi ;;
esac

# EVERY VERSION, NOT EVERY KEY. Four prefixes: the plan, its archive, the reverse
# token record, and the forward record — which is keyed by the SHA-256 of the raw
# token, so it can only be found by reading the reverse record first. Miss it and
# the plan is gone while its token still resolves to a dangling pointer.
TOKEN_SHA="$(aws_s3 s3 cp "s3://$BUCKET/plan-tokens/$ID.json" - 2>/dev/null \
  | python3 -c 'import json,sys,hashlib
t=json.load(sys.stdin)
t=t.get("token") or t.get("shareToken") or ""
print(hashlib.sha256(t.encode()).hexdigest() if t else "")' 2>/dev/null || true)"

PREFIXES=("data/$ID.json" ".history/$ID/" "plan-tokens/$ID.json")
[ -n "$TOKEN_SHA" ] && PREFIXES+=("tokens/$TOKEN_SHA.json")

echo "plan   : $ID"
echo "title  : $TITLE"
echo "bucket : $BUCKET"
[ -n "$TOKEN_SHA" ] || echo "note   : no reverse token record — the forward record cannot be found and will be left behind"

# ONE LISTING PER PREFIX, counted in python. The JMESPath that would do this in
# the query needs backticks, and a backtick inside a $( ) is a command
# substitution waiting to happen — this stays boring on purpose.
versions_of() { aws_s3 s3api list-object-versions --bucket "$BUCKET" --prefix "$1" --output json 2>/dev/null || echo '{}'; }
count_of() { python3 -c 'import json,sys
d=json.load(sys.stdin) or {}
print(len(d.get("Versions") or []), len(d.get("DeleteMarkers") or []))'; }

TOTAL=0
for P in "${PREFIXES[@]}"; do
  read -r N M <<<"$(versions_of "$P" | count_of)"
  echo "  $P - $N version(s), $M delete marker(s)"
  TOTAL=$((TOTAL + N + M))
done

if [ -z "$DO_IT" ]; then
  echo
  echo "DRY RUN. $TOTAL object version(s) would be destroyed, permanently, with no undo."
  echo "Re-run with --yes to do it."
  exit 0
fi

if [ -n "$FORCE" ]; then
  printf 'Type the plan id to confirm destroying a non-SCRATCH plan: '
  read -r typed
  [ "$typed" = "$ID" ] || { echo "did not match — nothing was deleted" >&2; exit 1; }
fi

for P in "${PREFIXES[@]}"; do
  # BOTH LISTS, IN ONE PASS. A delete marker left behind is a key that still
  # exists, which on a versioned bucket is the difference between "gone" and
  # "invisible to a plain GET".
  while :; do
    BATCH="$(versions_of "$P" | python3 -c 'import json,sys
d=json.load(sys.stdin) or {}
objs=[{"Key":o["Key"],"VersionId":o["VersionId"]}
      for o in (d.get("Versions") or []) + (d.get("DeleteMarkers") or [])][:500]
print(json.dumps({"Objects": objs}))')"
    COUNT="$(printf '%s' "$BATCH" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["Objects"]))')"
    [ "$COUNT" -gt 0 ] || break
    printf '%s' "$BATCH" > /tmp/nuke-batch.json
    aws_s3 s3api delete-objects --bucket "$BUCKET" --delete file:///tmp/nuke-batch.json >/dev/null
    rm -f /tmp/nuke-batch.json
    echo "  deleted $COUNT version(s) under $P"
  done
done

echo "✓ $ID destroyed — $TOTAL object version(s) removed from s3://$BUCKET"
