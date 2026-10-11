# One plan holds everything; a project is a channel inside it

A personal task list needs dependencies that cross between areas of work — cleaning up the
visualizations has to precede sharing the AI setup, and those are different efforts. A
dependency is an id inside one document, and the command log is transport rather than
storage (ADR 0001), so there is nothing to replay between two documents and no way to
build a cross-document edge. Therefore one plan holds all of a person's work and life
tasks, and "project" is a renamed existing channel rather than a plan of its own.

## Considered options

**One plan per project, with cross-plan links.** The intuitive shape, and wrong here: it
puts the thing the tool exists for — the dependency graph — on the one axis the storage
model cannot express. It would also require a cross-plan index, and there is deliberately
no endpoint that lists plans (ADR 0002): a plan is reachable only by its capability token,
so enumerating plans means dismantling the auth model.

**A new `project` channel key.** Rejected as unnecessary. `channelLabels` already renames a
channel per document, and `colors` is already filterable and available in the graph's
group-by, with an open-ended value vocabulary where borders, fills and shapes cap out at
their render styles. Setting `channelLabels.colors = "Project"` gets the concept for no
code.

## Consequences

The plan document grows without bound and is loaded whole, saved debounced after each
change. At the few hundred tasks a person accumulates this is fine; at tens of thousands it
would not be, and that is the point at which this decision needs revisiting rather than
patching.

Because everything lives in one document, the capability token protecting it now protects
a person's entire task list rather than one client's schedule. This is the main argument
for running a personal instance locally, where there is no link to leak.
