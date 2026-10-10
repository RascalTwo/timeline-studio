# ADR 0003 — A new shared ALB, not a migrated one

**Status:** accepted, 2026-08-20

## Context

`private-tldraw` already runs an ALB in this account, and an ALB costs roughly $16/month
before traffic. The obvious move is to share it: move it into a never-torn-down stack,
export the listener ARN, and have every app attach a `ListenerRule`.

The obstacle is that its ALB is defined *inside* `private-tldraw-compute` — the stack its
own README describes as the torn-down-for-cost half — and it is holding real content that
is in use.

## Decision

Stand up a **new** shared ALB. `private-tldraw` keeps its own, untouched. Migrating it
onto the shared one is a separate, later, deliberate operation.

**Amended:** this originally put the ALB in timeline-studio's own data stack, defined
under `timeline-studio/iac/`. That was the `private-tldraw` mistake with a different
name on it — shared infrastructure filed under whichever app happened to be first. It
now lives in its own stack and its own directory,
`shared-alb`, and timeline-studio imports
from it exactly as a second tenant would.

## Why

CloudFormation cannot move a live resource between stacks. Doing it properly means
setting `Retain` on the ALB and its listener, deploying, removing them from the source
template, then importing them into the target stack — a multi-step dance on a running
application, executed for an app that is not the one being built.

The interim cost is one extra ALB. That is the cheapest thing on the table compared to
disturbing something in use, and the owner's constraint was explicit: do not tear down
`private-tldraw`.

## Consequences

**Two ALBs until someone consolidates.** Roughly $16/month of avoidable spend, knowingly
accepted. Whoever migrates `private-tldraw` later should do it as its own reviewed change,
not as a side effect of something else.

> **Resolved 2026-08-22 — and not the way this asked for.** `private-tldraw` was migrated
> onto the shared ALB. Its own load balancer, listeners and ALB security group were deleted
> with `private-tldraw-compute`; it now attaches with a `ListenerRule` at priority 200
> (timeline-studio holds 100) whose host-header condition is `tldraw-sync…` itself, because
> nothing rewrites Host for that app — there is no CloudFront in front of its sync server.
> Its two per-app ACM certificates were dropped in favour of the shared wildcard. The
> account now holds exactly one ALB and the ~$16/month is reclaimed.
>
> The paragraph above asked for this to be its own reviewed change. **It was not** — it
> rode along with the collapse of both apps' `-data`/`-compute` stack pairs into single
> stacks, at the owner's explicit instruction after the tradeoff was argued. Recording the
> deviation rather than quietly satisfying the sentence: the risk this warned about was
> real and was accepted knowingly, not overlooked.
>
> One consequence this ADR did not anticipate: `private-tldraw`'s `power.sh down` used to
> reach a true ~$0 *because* its ALB was inside the stack being deleted. It no longer can,
> for exactly the reason named above — the shared ALB is a subdomain-level cost no single
> tenant's teardown can shed. Combined with Fargate billing only running tasks, that left
> `down` saving pennies, and it was removed from both apps.

**Security-group changes are now cross-tenant decisions.** The shared ALB's security group
belongs to every app behind it. Concretely:
`timeline-studio-origin.example.com` resolves publicly, so anyone who
learns that name can bypass CloudFront and reach the ALB directly. Under [ADR 0002](0002-capability-tokens-no-sso.md) that grants nothing a share
token did not already grant, so it is left open. Hardening it — restricting the SG to
CloudFront's managed prefix list — would be a decision *for every tenant of the ALB*, not
for this app. That is the real price of sharing, and it is worth more than the $16.

**The idle timeout is cross-tenant too, and it is not a listener setting.**
`idle_timeout.timeout_seconds` is a **load balancer** attribute — currently 300s — so it
applies to every listener and every app behind the ALB. That makes "raise the timeout to
keep WebSockets alive" a decision for all tenants, not for this one.

It should not be raised anyway. 300s is only the timeout *we* know about: CloudFront's own
behaviour for an established WebSocket is undocumented, and corporate proxies and NAT
gateways impose their own, typically 60–120s and not ours to configure. A server-side
keepalive survives all of them; a bigger ALB number survives only ours. The ping is
therefore sized against the smallest *unknown* intermediary, not against the 300s we can
see — and anyone who later widens it to "well within 300s" will break a plan open in a
meeting behind someone's corporate proxy.

**CloudFront does not validate that an origin resolves at create time.** This is what lets
the data stack reference an origin name the compute stack creates later, which is what
keeps the cutover ordering legal.
