# Use capability tokens instead of SSO

Status: Accepted, 2026-08-20

## Context and Problem Statement

The plans hold a client's real delivery schedule: team names, infrastructure, dates. The original tool kept them out of the repo entirely (`TIMELINE_DATA_DIR`, a gitignored `data/` symlinked outside the checkout). Hosting them means deciding who can reach them.

The host organisation runs Microsoft Entra ID, and two internal apps already sit on it as OIDC clients. The ALB supports `authenticate-oidc` natively, so SSO would have been a listener rule with no application code.

Collaborators outside the SA tenant have to be able to open a plan. Entra would need B2B guest invitations for every external participant: an invite flow, an admin step, and a login wall in front of a tool whose value is that you send someone a link and they are looking at the chart.

## Decision

No authentication at the door. A 128-bit random `shareToken` per plan is the capability, carried in the URL. This is the same model as the sibling `private-tldraw`, where the roomId is the capability.

Read these consequences before changing anything here.

**A leaked link is full read/write access for anyone on the internet.** Not anyone in the organisation: anyone. URLs leak through Slack, screenshares, browser history and forwarded invites. This was raised twice during design and accepted deliberately. It is the largest risk in this system.

**Plan ids are not the capability and must never become it.** They match `/^[a-z0-9][a-z0-9-]{0,63}$/i`, are human-meaningful, and become filenames. `eadvantage-member-api` is guessable on the first try by anyone who knows the client. The token is a separate field.

### The token's wire format is normative

16 crypto-random bytes as base64url: exactly 22 characters from `[A-Za-z0-9_-]`.

More than one component recognises a token by shape. The page splits `#<token>&<view state>` and must also accept a bare `#<token>` with no `&`, which it can only do by testing the shape of what it found.

This was already got wrong once. The minting side chose base64url-22 (a full 128 bits; `crypto.randomUUID()` spends 6 of its bits on version and variant nibbles). The page tested `/^[0-9a-f]{32}$/`. A real token would have failed that test, been treated as malformed view state and been silently discarded. Both sides were individually reasonable and nothing connected them.

Anything discriminating a token from view state uses `/^[A-Za-z0-9_-]{22}$/`. That cannot collide with encoded view state, which is `encodeURIComponent(JSON.stringify(...))` and so always begins `%7B`, and `%` is not in the base64url alphabet. If the format ever changes, it changes here first and every shape test follows.

### How tokens are stored

Two records per plan. The asymmetry is deliberate.

- `tokens/<sha256(token)>.json` holds `{id}`, the forward lookup. The key is a hash, not the token. Keying on the raw token would let anything holding `s3:ListBucket` enumerate every capability in one call, and would write tokens into S3 access logs and CloudTrail as key names.
- `plan-tokens/<id>.json` holds `{shareToken}`, the reverse record. It holds the real token because a link has to be re-derivable. It is keyed by plan id, so listing it reveals nothing a bucket-lister didn't already have.

Both records are written on every run, and a missing one is repaired rather than skipped. Idempotency keys on "both exist", never on either alone. A migration that crashes between the two writes would otherwise strand a capability that works forever and cannot be revoked, because revoking means deleting `tokens/<sha256(token)>` and that hash cannot be recomputed without the token that was never persisted. Write ordering does not fix this. Repair-on-run makes ordering irrelevant.

Bucket versioning is on. It covers a record that was written and later lost, not one that was never written. Versioning is now load-bearing in two places, the `.history/` archive and this repair story, so turning it off as a cost measure breaks something less obvious.

### How the token travels

In the URL fragment, never the path and never the query string. The page reads it from the fragment and sends it as a request header on each API call.

Browsers do not send the fragment to servers. A token carried there appears in no CloudFront access log, no ALB access log, no `Referer` header and no server-side request trace. In the path or query string it would land in all of them, and with CloudFront in front of the API there are two logging surfaces. Neither log type is enabled today, which makes this latent, and exactly the kind of thing someone switches on for debugging six months from now. This is the same argument as hashing the S3 forward key: the capability must not become a routine field in operational data.

Responses carrying plan data must never be cached. The `api/*` cache behavior uses the managed `CachingDisabled` policy. Since the token names the plan, every plan fetches the same URL and differs only by a header, and a cache key does not include a header unless the policy names it. A caching policy would collapse every plan onto one entry and serve whichever client's data arrived first to everyone after. That is a cross-tenant disclosure that looks like a caching bug.

### The token names the plan. Nothing else may.

The server resolves the plan from the token alone: hash it, read `tokens/<sha256(token)>.json`, use the `id` inside. A plan id supplied by the client is never trusted to select a plan. If a request could carry both a token and `?id=X` and the server honoured the id, one valid token would read every plan by varying the id, which is the enumeration this ADR forbids. So `?id=` is off the API surface. If it survives anywhere for compatibility, the server must verify it names the same plan the token resolves to and reject the request otherwise.

The id has since left the URL altogether. It addressed nothing, so all it did was name the client and project to anyone who saw the link. `saveHash` strips it rather than each call site remembering to, because every writer spreads `{...loadHash(), k: v}` and one that forgot would carry a stale id forever.

### Keeping the token out of the view-state blob

The fragment is `#<token>&<encoded view state>`, split on the first `&`. `saveHash` preserves the token verbatim without deserializing it.

The shape comes from a real bug found before any token existed. The shared viz kit's `loadHash` fails closed to `{}` on a malformed fragment, and every write is `saveHash({ ...loadHash(), key: value })`, so a fragment that does not parse is overwritten by the next click. In the original that cost a reload showing the demo. Here there is no picker and no `/list`, so with the token in that blob it would cost the only key to a plan someone has open, recoverable only by an operator with AWS credentials running `scripts/list-plans.sh`. A separate segment makes the invariant structural: code that never parses the token cannot drop it.

### Revoking a token

Delete `tokens/<sha256(token)>.json`. With versioning on that leaves a delete marker as the current version, so `GetObject` returns `NoSuchKey`, the server can no longer resolve the token and the link is dead. Revocation is real.

The superseded version lingers for the noncurrent-expiry window. Reading it needs `s3:GetObjectVersion`, which the task role does not have. Do not grant it to make deletion "really" delete: that trades a working revocation for every recovery path in the bucket, including the archive protection. The argument is commented at the grant site in `iac/compute-template.yaml`.

### Read access to the plans bucket is bigger than it looks

`plan-tokens/<id>.json` holds real tokens. So `s3:GetObject` on this bucket is equivalent to holding every share token for every plan. The task role needs it. Any other grant (a reporting job, a debugging role, an analytics tool) is a grant of total access to every client plan.

The reverse record stays anyway. It is the whole of `scripts/list-plans.sh`, the admin recovery path for "I lost the link". Without it a lost link means a permanently unreachable plan, since there is no `/list` and no picker. Permanent data loss is worse than a concentrated read grant, so the record stays and the grant gets guarded.

### Other consequences

- No plan-enumerating endpoint can exist. `/list` is removed, and so is the picker. One valid link must not expose a second plan.
- Agents use the same token. With no ALB auth there is no OIDC redirect to bypass, so the programmatic HTTP surface in `AGENTS.md` needs no separate credential path.
- Identity has to be built rather than inherited. Without OIDC there are no `x-amzn-oidc-*` headers, so save attribution and cursor names come from a self-chosen display name, prefilled with a random handle. Nothing verifies it.

## Alternatives Considered

- Entra ID through the ALB's `authenticate-oidc`: no application code and a real identity. Rejected because external collaborators would need guest invitations and a login wall.
- Deriving tokens with `HMAC(planId, serverSecret)`: attractive, with nothing to persist, no crash window, and a forward index rebuildable from the plan list. Rejected because it introduces a master key. One leaked secret computes every token for every plan, forever, including plans that do not exist yet. Random tokens keep a compromise bounded to what was read. Do not revisit without a new argument.
- Keying the forward record on the raw token, or carrying the token in the path or query string: rejected for the logging reasons above.

## More Information

- Adding Entra later is a listener rule plus an app registration, and it composes with the capability instead of replacing it: the token says which plan, Entra says you work here. That would turn a leaked link from an internet-wide exposure into an internal one. The cost remains the guest-invite flow.
- Related: [2026-08-20-stand-up-a-new-shared-alb.md](2026-08-20-stand-up-a-new-shared-alb.md) leaves the ALB origin open because of this decision.
- Rewritten 2026-11-13 from ADR 0002; alternatives reconstructed from code and history where the original did not record them.
