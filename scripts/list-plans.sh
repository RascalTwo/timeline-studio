#!/usr/bin/env bash
#
# EVERY PLAN AND ITS SHARE LINK. The admin recovery path for "I lost the link".
#
# NEEDS AWS CREDENTIALS, AND IS NOT REACHABLE FROM THE APP. This is an operator
# tool holding an operator's own credentials, run from a laptop against the
# bucket. It is deliberately not an endpoint: ADR 0002 removed `/list` and the
# picker because one valid link must not expose a second plan, and an enumerating
# route defeats the entire capability model in one call. Nothing in the server
# can do what this script does, and nothing in the server should be taught to.
#
# THIS PRINTS LIVE CAPABILITIES. Every line of output is full read/write access to
# a client's real delivery schedule for anyone on the internet who reads it. Do
# not paste the output into a ticket, a chat, a PR, or a shared drive; do not
# redirect it anywhere it will persist; do not run it on a screenshare. Send one
# person one line. That is the whole safe usage.
#
# It reads `plan-tokens/<id>.json`, which is the reverse record ADR 0002 keeps
# precisely so a lost link is recoverable — the forward record is keyed by the
# SHA-256 of the token and cannot be reversed. Reading this prefix is equivalent
# to holding every share token for every plan, which is why `s3:GetObject` on
# this bucket is a bigger grant than it looks.
#
#   ./scripts/list-plans.sh                       # ids and links
#   BASE_URL=https://example.cloudfront.net ./scripts/list-plans.sh
#   DATA_BUCKET=other-bucket ./scripts/list-plans.sh
#   S3_ENDPOINT=http://127.0.0.1:9210 ./scripts/list-plans.sh   # local S3 server
#
# DEAD LINKS ARE MARKED RATHER THAN PRINTED AS IF THEY WORKED. A plan whose
# forward record is missing has a token on record that resolves to nothing — the
# residue of a create that died between the two writes (see `issueToken` in
# sync-server/src/create.ts). For a script whose entire purpose is recovery,
# handing someone a link that silently 404s is the failure mode worth spending
# one extra GET per plan to avoid. `scripts/migrate-to-s3.ts` is the tool that
# repairs one; this only reports.

set -euo pipefail

# RESOLVED FROM THE STACK, not guessed. CloudFormation names the bucket, so a
# hardcoded default is a name that is wrong everywhere except one machine — and
# this is the script someone runs when they have LOST a link, which is the worst
# moment to hand them a wrong answer.
BUCKET="${DATA_BUCKET:-}"
if [ -z "$BUCKET" ] && [ -z "${S3_ENDPOINT:-}" ]; then
  BUCKET="$(aws cloudformation describe-stacks --stack-name timeline-studio \
    --query "Stacks[0].Outputs[?OutputKey=='DataBucketName'].OutputValue" --output text 2>/dev/null || true)"
  [ "$BUCKET" = "None" ] && BUCKET=""
fi
[ -n "$BUCKET" ] || { echo "could not resolve the plans bucket. Set DATA_BUCKET, or check the timeline-studio stack exists." >&2; exit 1; }
# The fragment is `#<token>`, never `?token=` — browsers do not send a fragment to
# a server, so a token carried there appears in no CloudFront or ALB access log
# and in no `Referer` when someone follows a link out of the page. In the path or
# query string it would land in all of them. See ADR 0002, "How the token travels".
BASE_URL="${BASE_URL:-}"
if [ -z "$BASE_URL" ] && [ -z "${S3_ENDPOINT:-}" ]; then
  BASE_URL="$(aws cloudformation describe-stacks --stack-name timeline-studio \
    --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue" --output text 2>/dev/null || true)"
  [ "$BASE_URL" = "None" ] && BASE_URL=""
fi
BASE_URL="${BASE_URL:-https://REPLACE-ME.cloudfront.net}"

aws_s3() { aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} "$@"; }

if ! aws_s3 sts get-caller-identity >/dev/null 2>&1 && [ -z "${S3_ENDPOINT:-}" ]; then
  echo "no AWS credentials — this script talks to the plans bucket directly." >&2
  echo "get some (aws sso login), then re-run." >&2
  exit 1
fi

# NOT `2>/dev/null`. With `set -euo pipefail` a swallowed error here killed the
# script silently -- no output, non-zero exit -- and for a recovery script silence
# reads as "you have no plans" rather than "you asked the wrong bucket".
if ! raw=$(aws_s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix 'plan-tokens/' \
             --query 'Contents[].Key' --output text 2>&1); then
  echo "could not list s3://$BUCKET/plan-tokens/ -- the bucket may not exist, or the" >&2
  echo "credentials may not reach it. AWS said:" >&2
  echo "  $raw" >&2
  exit 1
fi
ids=$(printf '%s' "$raw" | tr '\t' '\n' | sed -n 's|^plan-tokens/\(.*\)\.json$|\1|p' | sort)

if [ -z "$ids" ]; then
  echo "no plans in s3://$BUCKET/plan-tokens/" >&2
  exit 0
fi

printf '%s\n' "$ids" | while IFS= read -r id; do
  [ -n "$id" ] || continue
  token=$(aws_s3 s3 cp "s3://$BUCKET/plan-tokens/$id.json" - 2>/dev/null \
          | sed -n 's/.*"shareToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

  if [ -z "$token" ]; then
    printf '%-40s  !! no shareToken in plan-tokens/%s.json\n' "$id" "$id"
    continue
  fi

  # `printf` is a shell builtin, so the token never reaches a process argument
  # list and never shows up in `ps` for anyone else on the box. It is about to be
  # printed to this terminal either way; that is not a reason to also broadcast it
  # to every other user of the machine.
  hash=$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)

  if aws_s3 s3api head-object --bucket "$BUCKET" --key "tokens/$hash.json" >/dev/null 2>&1; then
    printf '%-40s  %s#%s\n' "$id" "$BASE_URL/" "$token"
  else
    # The token is real and revocable; it just resolves to nothing until the
    # forward record is rewritten. Printing it anyway is deliberate — it is the
    # only copy, and losing it here is how a plan becomes permanently unreachable.
    printf '%-40s  %s#%s   !! DEAD: tokens/%s.json missing, run migrate-to-s3.ts to repair\n' \
      "$id" "$BASE_URL/" "$token" "$hash"
  fi
done
