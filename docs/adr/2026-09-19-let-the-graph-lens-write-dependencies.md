# Let the graph lens write dependencies

Status: Accepted, 2026-09-19

## Context and Problem Statement

The graph lens was built as a read-only view and said so in its own header: "Nothing here writes to the plan and nothing here can move a date." That was right while a plan was a delivery schedule someone presented. It stopped being right when a plan became the place a person's whole task list lives. The question you bring to a dependency graph is then "what is in the way", and the answer is often "nothing yet, because I have not drawn it".

## Decision

Dragging a handle between two nodes adds a dependency.

The graph still cannot move a date. Position on the graph is not time and never was, so no gesture here edits a duration, a start or a deadline. Those stay on the timeline, where position means something. Writing is limited to the one relationship the picture is about.

Consequences:

- Two gestures now draw a dependency: click-link-click, which already worked on both views, and the drag. They share `linkTasks`, which owns the cycle check. The server deliberately does not enforce that rule, because catching it there would mean a second copy of the scheduler behind the wire. A cycle drawn on the graph would otherwise be accepted, broadcast, and turn every connected chart into the "⚠" verdict at once. So the check happens before the command is sent and must not be duplicated per gesture.
- Cytoscape stopped being a CDN import and became a bundled dependency, loaded lazily. This is not strictly part of the decision, but has the same cause: a graph that needs the internet is not one a local-only instance can rely on.

## Alternatives Considered

- Keep the graph read-only: no write paths to guard. Rejected because the missing edges are the common case, and the user would have to leave the graph to add them.
- Let the graph edit dates and durations too: rejected because graph position carries no time.
- Enforce the cycle check on the server: rejected because it needs the scheduler behind the wire.

## More Information

- Related: [2026-09-19-use-cytoscape-for-the-graph-view.md](2026-09-19-use-cytoscape-for-the-graph-view.md).
- Rewritten 2026-11-13 from ADR 0007; alternatives reconstructed from code and history where the original did not record them.
