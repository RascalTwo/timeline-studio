# The API is the product; the UI is one viewer of it

Anything Timeline Studio knows must be reachable as data over the API. The page is a
viewer — a very good one, tuned for a human in a meeting — and not the place any fact
lives. If someone wanted to build a terminal UI, a mobile app, or drive the whole thing
from an agent, the API alone has to be enough.

## What counts as a violation

A fact the page can state and the API cannot. Two were found the day this was written,
both by handing a cold agent a URL and watching what it could not do:

- **Readiness.** The chart says which tasks are startable and which of `deps`,
  `notBefore` or a full lane is holding each one back. `sched` computes it and attaches
  it to its result with `Object.defineProperty`, which makes it non-enumerable — so it
  survives a function call and vanishes through `JSON.stringify`. The agent had to fetch
  `/schedule.js` and run the scheduler itself to answer "what can I start now".
- **`GET /api/plan` was undocumented**, which is the same failure one level up: the fact
  was reachable and nobody could find it.

## What is NOT a violation

Rendering is not a fact. That a task is drawn in `#5aa9f0`, that a bar is 40 pixels wide
at this zoom, that a node sits where somebody dragged it — the API carries the colour id,
the duration and the coordinates, and turning those into pixels is the viewer's whole
job. The test is whether another client could make its own decision from the same data,
not whether it would make the same one.

Presentation state that only means something to one viewer stays out of the document for
the same reason: the zoom level and the fold are in `localStorage`. A hand-arranged graph
is the exception that proves the rule — `graphPos` is on the document because it is work
somebody did, not a preference, and a second client should see it.

## Consequences

`GET /api/ready` exists because of this rule rather than because anybody asked for it.

Adding a derived number to the chart now comes with a question: can a caller get it from
the API? If the answer is no, the feature is not finished. That is a real cost on every
future change to the page, and it is the point.

## Both directions, and actions too (2026-09-26)

The owner's statement of the rule, when comments were added: Timeline Studio is a
library as much as a service, and **everything you can do in it must be doable through
the API and through the UI** — except what is only visual. So the test above applies to
actions as well as facts, and in both directions:

- A thing you can **do** on the page — add a comment, reorder a queue, switch on
  Auto-order — has a command or route an agent can send.
- A thing the API can **do** has a place on the page. An endpoint nobody can reach
  without curl is as unfinished as a chart number nobody can reach without the page.
