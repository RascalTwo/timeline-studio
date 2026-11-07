#!/usr/bin/env bash
# Tag every drop so its commit stays fetchable after main is force-pushed again.
#
# The Source Allies copy deploys a pinned commit of this repo (sai-jm-snippets,
# timeline-studio/scripts/deploy-pinned.sh). main is one orphan commit replaced on
# each drop, so without a ref pointing at it the pinned commit is gone from the
# remote the next time anyone publishes. Tags do not trigger CI.
set -euo pipefail
sha="$(git rev-parse main)"
tag="drop-$(date -u +%Y%m%dT%H%M%SZ)"
git tag "$tag" "$sha"
git push -q origin "refs/tags/$tag"
echo "tagged $tag -> $sha"
