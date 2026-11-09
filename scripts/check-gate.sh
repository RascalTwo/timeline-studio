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

# LINT FIRST (2s), because it is the cheapest check that can fail for a reason the suites would not
# show. Zero findings or fail: there is no known-red ledger for lint, and a failure here has no
# `N/N checks passed` line either. Type-aware Oxlint per program; a skipped engine is a failure
# (scripts/lint.ts), never a quiet pass. Fix the code, or give the rule a reason in lint-config.ts.
if ! lintout=$(npm run --silent lint 2>&1); then
  echo "✗ lint failed — this is not a known-red situation" >&2
  echo "$lintout" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  Run: npm run lint   (in scripts/). AGENTS.md says how to disable a rule, with a reason." >&2
  exit 1
fi

# FORMAT NEXT, AND HERE RATHER THAN ONLY INSIDE `npm run check`. It takes a tenth of a
# second, so a mis-formatted file should not cost a 75s run, and a failure that is not one
# of the suites has no `N/N checks passed` line, which the branch below would report as
# "the run did not finish". `npm run check` runs it again as its second step; that is the
# same command, so the two cannot disagree. Never known-red-able: fix it with the formatter.
if ! fmt=$(npm run --silent format:check 2>&1); then
  echo "✗ not formatted — this is not a known-red situation" >&2
  echo "$fmt" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  Run: npm run format   (in scripts/), then stage the files by name" >&2
  exit 1
fi

echo "→ npm run check (lint, format, then the sync-server suite and the browser suite twice together, coverage floor, ~80s; CHECK_BROWSERS=1 runs the browsers one at a time)"
npm run check > "$LOG" 2>&1
rc=$?

# COVERAGE NEXT, AND NEVER KNOWN RED. scripts/coverage-floor.ts prints `✗ coverage: …` for a number below
# its floor, a suite that left no data, an exclusion without a reason. Like format:check there is no
# ledger for it, so it is read before known-red.txt is. A run that never reached it (an earlier step
# failed, even a known-red one) has no `coverage: page` summary and fails here for that alone: nothing
# is measured from nothing.
if grep -q '^✗ coverage' "$LOG"; then
  echo "✗ coverage — this is not a known-red situation" >&2
  grep -E '^(coverage:|✗ coverage)' "$LOG" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  The report listing the uncovered lines is in .verify/coverage/ (path in the message above)" >&2
  exit 1
fi

# The sync-server suite and the parity check do not print FAIL lines; if either
# died, the run never reached the browser suites and there is nothing to compare.
# TWO browser runs print one `N/N checks passed` each (the unminified bundle coverage is measured on, and
# the minified one the deploy ships, which also leaves web/dist as `npm run build` makes it); one line means one never finished.
if [ "$(grep -cE '^[0-9]+/[0-9]+ checks passed' "$LOG")" -ne 2 ]; then
  echo "✗ the run did not finish — this is not a known-red situation" >&2
  tail -30 "$LOG" >&2
  echo "" >&2
  echo "  Full log kept: $LOG" >&2   # kept so an intermittent failure can be named afterwards
  trap - EXIT
  exit 1
fi

if ! grep -q '^coverage: page' "$LOG"; then
  echo "✗ the coverage step never ran — this is not a known-red situation" >&2
  tail -30 "$LOG" >&2
  trap - EXIT
  echo "  Full log kept: $LOG" >&2
  exit 1
fi
grep -E '^(coverage:|floor raised)' "$LOG"

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
