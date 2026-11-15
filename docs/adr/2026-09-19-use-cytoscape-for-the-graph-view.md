# Use Cytoscape.js for the dependency graph view, not tldraw

Status: Accepted, 2026-09-19

## Context and Problem Statement

The graph view must let you draw an edge to create a dependency, keep a manual arrangement you dragged into place, style nodes by readiness, and stay readable at a few hundred nodes. tldraw is the more natural canvas and an earlier prototype used it. Its SDK is not open source: without a license key in production it stops rendering after five seconds, the hobby tier is discretionary and watermarked, and the licence forbids interfering with that enforcement.

## Decision

The graph view uses Cytoscape.js. It is MIT and does every required job. Graph semantics are native. Edge drawing is a maintained, purpose-built extension. DAG auto-layout is first-party and current. Readiness tiers fall out of a declarative stylesheet. Positions serialize and restore in about ten lines. An existing retired project in this repo family already implemented readiness tiering against it.

Tradeoffs accepted:

- Nodes are canvas-rendered, so there is no rich editing inside a node. Editing happens in a side panel driven by selection. The HTML-in-node extension has been stale since 2021 and must not be built on.
- Auto-layout is a button rather than the architecture. Manual positions are the stored truth, and a layout run overwrites them on request.

## Alternatives Considered

- tldraw: better at one thing. Shapes are React, so a node can be a rich editing surface, and persisted positions are free because position is the document. The fatal problem is licensing, not capability. No key is required on localhost, so tldraw would work for a local-only instance and silently forbid ever deploying one. A library licence should not decide whether this tool can be deployed.

## More Information

- Rewritten 2026-11-13 from ADR 0006; alternatives reconstructed from code and history where the original did not record them.
