# Treat the API as the product, with the UI as one viewer of it

Status: Accepted, 2026-09-19

## Context and Problem Statement

Timeline Studio is a library as much as a service. If someone wants to build a terminal UI or a mobile app, or drive the whole thing from an agent, the API alone has to be enough. The page is a very good viewer tuned for a human in a meeting, and it must not be the only place any fact lives.

Two violations were found the day this was written, both by handing a cold agent a URL and watching what it could not do:

- Readiness. The chart says which tasks are startable and which of `deps`, `notBefore` or a full lane is holding each back. `sched` computes it and attaches it to its result with `Object.defineProperty`, which makes it non-enumerable. It survives a function call and vanishes through `JSON.stringify`. The agent had to fetch `/schedule.js` and run the scheduler itself to answer "what can I start now".
- `GET /api/plan` was undocumented. This is the same failure one level up: the fact was reachable and nobody could find it.

## Decision

Anything Timeline Studio knows must be reachable as data over the API. A fact the page can state and the API cannot is a violation. The rule covers actions as well as facts, in both directions (added 2026-09-26, when comments were added): everything you can do in Timeline Studio must be doable through the API and through the UI, except what is only visual.

- A thing you can do on the page (add a comment, reorder a queue, switch on Auto-order) has a command or route an agent can send.
- A thing the API can do has a place on the page. An endpoint nobody can reach without curl is as unfinished as a chart number nobody can reach without the page.

What is not a violation: rendering. That a task is drawn in `#5aa9f0`, that a bar is 40 pixels wide at this zoom, that a node sits where somebody dragged it. The API carries the colour id, the duration and the coordinates, and turning those into pixels is the viewer's job. The test is whether another client could make its own decision from the same data, not whether it would make the same one.

Presentation state that only means something to one viewer stays out of the document: zoom level and fold are in `localStorage`. A hand-arranged graph is the exception that proves the rule. `graphPos` is on the document because it is work somebody did, not a preference, and a second client should see it.

Consequences: `GET /api/ready` exists because of this rule rather than because anybody asked for it. Adding a derived number to the chart now comes with a question: can a caller get it from the API? If not, the feature is not finished. That is a real cost on every future change to the page, and it is the point.

## Alternatives Considered

- The page as the primary product, with the API as a convenience: lets the page compute and hold facts, so each feature is cheaper. Rejected because it leaves agents and other clients running the scheduler themselves or scraping the page.
- Exposing only facts and not actions: rejected in the 2026-09-26 extension, because an action only the page can do is as unreachable to an agent as a fact.

## More Information

- Rewritten 2026-11-13 from ADR 0008; alternatives reconstructed from code and history where the original did not record them.
