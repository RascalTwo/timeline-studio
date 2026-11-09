# The graph lens can write

The graph lens was built as a read-only view and says so in its own header:
"Nothing here writes to the plan and nothing here can move a date." That was right
while a plan was a delivery schedule someone presented, and stopped being right when
a plan became the place a person's whole task list lives. The question you bring to a
dependency graph then is "what is in the way", and the answer is very often "nothing
yet, because I have not drawn it". Dragging a handle between two nodes now adds a
dependency.

## What did not change

It still cannot move a date. Position on the graph is not time and never was, so
there is no gesture here that edits a duration, a start, or a deadline — those stay
on the timeline, where position means something. Writing is limited to the one
relationship the picture is actually about.

## Consequences

There are now two gestures that draw a dependency: click-link-click, which already
worked on both views, and the drag. They share `linkTasks`, which owns the cycle
check — the one rule the server deliberately does not enforce, because catching it
there would mean a second copy of the scheduler behind the wire. A cycle drawn on
the graph would otherwise be accepted, broadcast, and turn every connected chart
into the "⚠" verdict at once, so the check has to happen before the command is sent
and must not be duplicated per gesture.

Cytoscape also stopped being a CDN import and became a bundled dependency, lazily
loaded. Not strictly part of this decision, but the same cause: a graph that needs
the internet is not a graph a local-only instance can rely on.
