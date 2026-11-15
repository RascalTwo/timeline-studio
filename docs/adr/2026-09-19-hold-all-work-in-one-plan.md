# Hold all of a person's work in one plan, with a project as a channel inside it

Status: Accepted, 2026-09-19

## Context and Problem Statement

A personal task list needs dependencies that cross between areas of work. Cleaning up the visualizations has to precede sharing the AI setup, and those are different efforts. A dependency is an id inside one document. The command log is transport rather than storage ([2026-08-20-use-a-server-authoritative-command-log.md](2026-08-20-use-a-server-authoritative-command-log.md)), so there is nothing to replay between two documents and no way to build a cross-document edge.

## Decision

One plan holds all of a person's work and life tasks. A "project" is a renamed existing channel, not a plan of its own. Setting `channelLabels.colors = "Project"` gets the concept with no code.

Consequences:

- The plan document grows without bound and is loaded whole, then saved debounced after each change. At the few hundred tasks a person accumulates this is fine. At tens of thousands it would not be, and that is when this decision needs revisiting rather than patching.
- Everything lives in one document, so the capability token protecting it protects a person's entire task list rather than one client's schedule. This is the main argument for running a personal instance locally, where there is no link to leak.

## Alternatives Considered

- One plan per project, with cross-plan links: the intuitive shape, and wrong here. It puts the dependency graph, the thing the tool exists for, on the one axis the storage model cannot express. It would also need a cross-plan index, and there is deliberately no endpoint that lists plans ([2026-08-20-use-capability-tokens-instead-of-sso.md](2026-08-20-use-capability-tokens-instead-of-sso.md)). A plan is reachable only by its capability token, so enumerating plans means dismantling the auth model.
- A new `project` channel key: rejected as unnecessary. `channelLabels` already renames a channel per document, and `colors` is already filterable and available in the graph's group-by, with an open-ended value vocabulary where borders, fills and shapes cap out at their render styles.

## More Information

- Rewritten 2026-11-13 from ADR 0005; alternatives reconstructed from code and history where the original did not record them.
