# Cytoscape.js for the dependency graph view, not tldraw

The graph view must let you draw an edge to create a dependency, keep a manual arrangement
you dragged into place, style nodes by readiness, and stay readable at a few hundred
nodes. tldraw is the more natural canvas and an earlier prototype used it, but its SDK is
not open source: without a license key in production it stops rendering after five
seconds, the hobby tier is discretionary and watermarked, and the licence forbids
interfering with that enforcement. Cytoscape.js is MIT and does every required job, so the
graph view uses Cytoscape.

## Considered options

**tldraw.** Genuinely better at one thing: shapes are React, so a node can be a rich
editing surface. It also makes persisted positions free, because position *is* the
document. Fatal problem is not capability but licensing — no key is required on localhost,
so tldraw would work for a local-only instance and silently forbid ever deploying one.
Letting a library licence decide whether this can be deployed is the wrong dependency for
a tool meant to last.

**Cytoscape.js.** Graph semantics are native. Edge drawing is a maintained, purpose-built
extension; DAG auto-layout is first-party and current; readiness tiers fall out of a
declarative stylesheet; positions serialize and restore in about ten lines. An existing
retired project in this repo family already implemented readiness tiering against it.

## Consequences

Nodes are canvas-rendered, so there is no rich editing *inside* a node. Editing happens in
a side panel driven by selection. The maintained HTML-in-node extension has been stale
since 2021 and must not be built on.

Auto-layout becomes a button rather than the architecture: manual positions are the stored
truth, and a layout run overwrites them on request.
