#!/usr/bin/env bash
# THE GATE. `npm run check` with one extra job: decide whether the red it found
# is red anybody already knew about.
#
# WHY THIS EXISTS RATHER THAN A BARE `npm run check` IN THE HOOK. The browser
# suite has four failures that are the page's fault and are not going to be fixed
# in the commit that happens to trip over them. A gate that is red the day it is
# installed is a gate everybody learns to pass with --no-verify inside a week,
# and then it is worse than nothing, because the repo now believes it has one.
# So: known red is recorded by NAME in known-red.txt and does not block; anything
# else does.
#
# It also fails when a KNOWN name passes, which is the half that keeps the list
# honest. A baseline you can only add to stops describing the suite.
#
# Run it by hand any time: scripts/check-gate.sh
set -uo pipefail
cd "$(dirname "$0")"

LIST=known-red.txt
LOG=$(mktemp "${TMPDIR:-/tmp}/ts-check.XXXXXX")
trap 'rm -f "$LOG"' EXIT

echo "→ npm run check (three suites, ~90s)"
npm run check > "$LOG" 2>&1
rc=$?

# The sync-server suite and the parity check do not print FAIL lines; if either
# died, the run never reached the browser suite and there is nothing to compare.
if ! grep -qE '^[0-9]+/[0-9]+ checks passed' "$LOG"; then
  echo "✗ the run did not finish — this is not a known-red situation" >&2
  tail -30 "$LOG" >&2
  echo "" >&2
  echo "  Full log kept: $LOG" >&2   # kept so an intermittent failure can be named afterwards
  trap - EXIT
  exit 1
fi

# Names only. The detail after the em dash carries row counts and timings that
# differ run to run, so matching on it would make every entry here rot.
sed -n 's/^FAIL \(.*\)$/\1/p' "$LOG" | sed 's/ — .*$//' | sort -u > "$LOG.now"
grep -vE '^\s*(#|$)' "$LIST" | sort -u > "$LOG.known"

new=$(comm -23 "$LOG.now" "$LOG.known")
fixed=$(comm -13 "$LOG.now" "$LOG.known")
rm -f "$LOG.now" "$LOG.known"

grep -E '^[0-9]+/[0-9]+ checks passed' "$LOG"

if [ -n "$new" ]; then
  echo "" >&2
  echo "✗ NEW failing checks — not in $LIST:" >&2
  echo "$new" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  Full log kept: $LOG" >&2
  trap - EXIT
  exit 1
fi

if [ -n "$fixed" ]; then
  echo "" >&2
  echo "✗ these are in $LIST but PASSED — delete the lines:" >&2
  echo "$fixed" | sed 's/^/    /' >&2
  exit 1
fi

# rc is non-zero whenever anything failed, including the known red, so it cannot
# be the answer on its own.
[ "$rc" -ne 0 ] && echo "  (all red is known red — see $LIST)"
echo "✓ check-gate passed"
exit 0
