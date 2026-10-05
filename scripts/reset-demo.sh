#!/usr/bin/env bash
# Put the shared demo plan back to the bakery it started as.
#
# `demo-bakery` is reachable by a token published in the page, with no login, on
# purpose (ADR 0002) — anyone who opens it can edit it, and eventually somebody
# leaves it in a state you would rather not hand a client. That is a feature with
# a cleanup cost. This is the cleanup.
#
# REVERT, NOT A WHOLE-DOCUMENT WRITE, because there is no whole-document write.
# `patchDoc` refuses `tasks` (every task mutation is its own command, so
# concurrent edits merge — ADR 0001) and refuses `schemaVersion` (the migration
# ladder owns it). /api/revert is the one operation that replaces the room's
# document atomically, and it is documented as a deliberate act rather than a
# cleanup step — which is exactly what this is.
#
# NOT A BUTTON IN THE UI, deliberately. The demo is one shared room: a reset
# control anyone could press would discard whatever the person already in there
# was doing, which is the failure /api/revert's own docs say to avoid.
#
#   BASE=http://127.0.0.1:8080 ./scripts/reset-demo.sh   # a local stack
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
BASE="${BASE:?set BASE to the server to reset, e.g. http://127.0.0.1:8090}"
# The one token that belongs in this repo: it addresses a plan that exists to be
# opened by strangers and broken by them. Every other token is a client's
# delivery schedule and must never be written down.
TOKEN="${DEMO_TOKEN:-demoBakeryPublic012345}"
export SEED="$ROOT/web/demo-plan.json"
# The note that marks a version as the pristine bakery. Written by whoever
# established it; matched here rather than hardcoding a number, because version
# numbers move every time anybody saves and a hardcoded 4 would silently start
# restoring somebody's half-finished edit.
MARK="${DEMO_MARK:-clean starting state}"

api() { curl -sS --max-time 90 -H "x-timeline-token: $TOKEN" -H "x-timeline-by: reset-demo.sh" "$@"; }

N=$(api "$BASE/api/history" | MARK="$MARK" python3 -c '
import json,sys,os
mark = os.environ["MARK"]
vs = [v for v in json.load(sys.stdin)["versions"] if mark in (v.get("note") or "")]
if not vs:
    sys.stderr.write(f"no archived version whose note contains {mark!r}.\n"
                     "Establish one: open the demo, put it right by hand, and Save with that phrase in the note.\n")
    raise SystemExit(1)
print(max(v["n"] for v in vs))')

echo "→ reverting the demo at $BASE to v$N (\"$MARK\")"
api -X POST -H "content-type: application/json" -d "{\"n\":$N}" "$BASE/api/revert" >/dev/null

# DRIFT CHECK. web/demo-plan.json is the tracked seed for the demo, so if the
# archived clean version and it stop being the same bakery, the demo people look
# at and the plan the tests assert on quietly become two different things. Reported, never auto-fixed: which one is right is
# a judgement, and guessing would overwrite the answer.
api "$BASE/api/plan" > /tmp/reset-demo-live.json
# MIGRATED BEFORE COMPARING. The seed is tracked at the schema it was written at;
# the live plan has been through the ladder. Comparing them raw reports every
# duration as drift, because schema 4 turned weeks into days — "2" and "14" are
# the same fortnight and the first version of this check called them a conflict.
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { applyMigrations } from "./shared/schedule.js";
writeFileSync("/tmp/reset-demo-seed.json",
  JSON.stringify(applyMigrations(JSON.parse(readFileSync(process.env.SEED, "utf8")))));
'
N="$N" python3 -c '
import json, os, sys
live = json.load(open("/tmp/reset-demo-live.json")); live = live.get("doc", live)
seed = json.load(open("/tmp/reset-demo-seed.json"))
# `schemaVersion` is handled by migrating above. `order` was the old plan
# picker position field — the picker is gone and nothing in the page or the
# server reads `doc.order` any more, but it still rides along in every stored
# plan, so comparing it would report permanent drift over a field with no meaning.
skip = {"schemaVersion", "order"}
diff = [k for k in set(seed) | set(live)
        if k not in skip and json.dumps(seed.get(k), sort_keys=True) != json.dumps(live.get(k), sort_keys=True)]
if diff:
    print(f"⚠ demo reset, but it has DRIFTED from web/demo-plan.json: {sorted(diff)}")
    print("  The suite forks the seed; visitors see the plan. Reconcile them before trusting either.")
else:
    print(f"✓ demo reset to v{os.environ.get("N","?")} and matches web/demo-plan.json ({len(seed["tasks"])} tasks)")
'
