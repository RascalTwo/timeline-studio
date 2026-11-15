# Add comments to tasks

Status: Accepted, 2026-09-26

## Context and Problem Statement

Descriptions were doing two jobs. 74 of 150 described tasks carried dated paragraphs ("Rascal Two 2026-09-26: …", "UPDATE …") appended by people and agents to record what had happened. But a description is what a sign-off covers, so every appended line cleared the task's `refinedAt`, and logging progress un-refined the work.

## Decision

- A task has `comments`: `{ id, text, at, by, editedAt? }`, oldest first, like comments on a GitHub issue. They are named comments, not notes, because "note" is already the text on a saved version (`/api/histnote`).
- Three commands: `addComment`, `editComment` and `removeComment`. None clears `refinedAt` or moves `updatedAt`, because a comment is about the task and not a change to what it says.
- The comment's id travels on the command, since the applier may not invent one. The page sets id, time and author, and the room fills them for an API caller that sent only `text`.
- Comments are editable and deletable by anyone, because there are no accounts to enforce otherwise and History keeps every saved version.
- They show only in the Inspector, below everything else, scrolled to the newest.
- No schema version bump: an optional field, and no existing data changes shape.

The dated paragraphs already in descriptions were moved into comments by hand, with an agent reading each one and deciding. A migration script was not used, because telling a log entry from the definition of a task is a judgment and not a pattern.

## Alternatives Considered

- Keep appending to descriptions and exempt log lines from clearing `refinedAt`: rejected because the system cannot tell a log line from a change to the definition.
- Call them notes: rejected, see above.
- Migrate old paragraphs with a script: rejected, see above.

## More Information

- Rewritten 2026-11-13 from ADR 0013; alternatives reconstructed from code and history where the original did not record them.
