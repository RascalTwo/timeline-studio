# Comments on tasks

2026-09-26.

Descriptions were doing two jobs. 74 of 150 described tasks carried dated paragraphs —
"Rascal Two 2026-09-26: …", "UPDATE …" — appended by people and agents to record what had
happened. But a description is what a sign-off covers, so every appended line cleared the
task's `refinedAt`: logging progress un-refined the work.

## Decision

- A task has **`comments`**: `{ id, text, at, by, editedAt? }`, oldest first, like
  comments on a GitHub issue. Named *comments*, not *notes*, because "note" is already the
  text on a saved version (`/api/histnote`).
- `addComment`, `editComment`, `removeComment`. None of them clears `refinedAt` or moves
  `updatedAt` — a comment is about the task, not a change to what it says.
- The comment's id travels on the command (the applier may not invent one); the page sets
  id, time and author, and the room fills them for an API caller that sent only `text`.
- Editable and deletable by anyone: there are no accounts to enforce otherwise, and
  History keeps every saved version.
- Shown only in the Inspector, below everything else, scrolled to the newest.
- No schema version bump: an optional field, and no existing data changes shape.

The dated paragraphs already in descriptions were moved into comments by hand — an agent
reading each one and deciding — not by a migration script, because telling a log entry
from the definition of a task is a judgment, not a pattern.
