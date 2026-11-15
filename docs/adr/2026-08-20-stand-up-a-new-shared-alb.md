# Stand up a new shared ALB instead of migrating the existing one

Status: Accepted, 2026-08-20

## Context and Problem Statement

`private-tldraw` already runs an ALB in this account, and an ALB costs roughly $16/month before traffic. The obvious move is to share it: move it into a never-torn-down stack, export the listener ARN, and have every app attach a `ListenerRule`.

The obstacle is that its ALB is defined inside `private-tldraw-compute`, the stack its README describes as the torn-down-for-cost half, and it holds real content that is in use. CloudFormation cannot move a live resource between stacks. Doing it properly means setting `Retain` on the ALB and its listener, deploying, removing them from the source template, then importing them into the target stack. That is a multi-step dance on a running application, executed for an app that is not the one being built. The owner's constraint was explicit: do not tear down `private-tldraw`.

## Decision

Stand up a new shared ALB. `private-tldraw` keeps its own, untouched. Migrating it onto the shared one is a separate, later, deliberate operation. The interim cost is one extra ALB, the cheapest option compared to disturbing something in use.

Amended: this originally put the ALB in timeline-studio's own data stack under `timeline-studio/iac/`. That was the `private-tldraw` mistake with a different name: shared infrastructure filed under whichever app came first. It now lives in its own stack and directory, `shared-alb`, and timeline-studio imports from it as a second tenant would.

Consequences:

- Two ALBs until someone consolidates, roughly $16/month of avoidable spend, knowingly accepted. Whoever migrates `private-tldraw` should do it as its own reviewed change.
- Security-group changes are cross-tenant decisions. The shared ALB's security group belongs to every app behind it. `timeline-studio-origin.example.com` resolves publicly, so anyone who learns the name can bypass CloudFront and reach the ALB directly. Under [2026-08-20-use-capability-tokens-instead-of-sso.md](2026-08-20-use-capability-tokens-instead-of-sso.md) that grants nothing a share token did not already grant, so it is left open. Restricting the group to CloudFront's managed prefix list would be a decision for every tenant, not this app. That is the real price of sharing, and it is worth more than the $16.
- The idle timeout is cross-tenant too. `idle_timeout.timeout_seconds` is a load balancer attribute (currently 300s), not a listener setting, so it applies to every app behind the ALB. Raising it to keep WebSockets alive is a decision for all tenants. It should not be raised anyway. 300s is only the timeout we know about: CloudFront's behaviour for an established WebSocket is undocumented, and corporate proxies and NAT gateways impose their own, typically 60 to 120s. A server-side keepalive survives all of them, while a bigger ALB number survives only ours. The ping is sized against the smallest unknown intermediary, not against the 300s we can see. Widening it to "well within 300s" would break a plan open in a meeting behind someone's corporate proxy.
- CloudFront does not validate that an origin resolves at create time. That lets the data stack reference an origin name the compute stack creates later, which keeps the cutover ordering legal.

### Resolved 2026-08-22, not the way this asked for

`private-tldraw` was migrated onto the shared ALB. Its own load balancer, listeners and ALB security group were deleted with `private-tldraw-compute`. It now attaches with a `ListenerRule` at priority 200 (timeline-studio holds 100) whose host-header condition is `tldraw-sync…` itself, because nothing rewrites Host for that app: there is no CloudFront in front of its sync server. Its two per-app ACM certificates were dropped in favour of the shared wildcard. The account holds exactly one ALB and the ~$16/month is reclaimed.

The decision above asked for this to be its own reviewed change. It was not. It rode along with the collapse of both apps' `-data`/`-compute` stack pairs into single stacks, at the owner's explicit instruction after the tradeoff was argued. The deviation is recorded rather than quietly satisfied: the risk was real and was accepted knowingly.

One consequence was not anticipated. `private-tldraw`'s `power.sh down` used to reach a true ~$0 because its ALB was inside the stack being deleted. It no longer can, because the shared ALB is a subdomain-level cost no single tenant's teardown can shed. With Fargate billing only running tasks, `down` saved pennies and was removed from both apps.

## Alternatives Considered

- Migrate the `private-tldraw` ALB into a shared stack first: saves the $16/month at once. Rejected because CloudFormation cannot move a live resource between stacks, so it needs a `Retain` and import sequence on a running application for an app that is not the one being built.
- Put the new ALB in timeline-studio's own data stack: the original form of this decision. Rejected in the amendment because it files shared infrastructure under one app.

## More Information

- Rewritten 2026-11-13 from ADR 0003; alternatives reconstructed from code and history where the original did not record them.
