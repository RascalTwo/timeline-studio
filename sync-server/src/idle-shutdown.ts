import { ECSClient, ListServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs'

// Copied essentially as-is from the sibling `private-tldraw`, which had no tldraw
// in it to begin with — the signal it scales on is open rooms, and that concept
// survived the port unchanged.

// The cluster this task runs in. Its presence is the prod/local switch: unset in
// local dev and the pre-deploy gate, so the monitor is a no-op there and never
// touches AWS. Set by the task definition in prod (see iac/compute-template.yaml).
const CLUSTER = process.env.ECS_CLUSTER
const IDLE_MINUTES = Number(process.env.IDLE_SHUTDOWN_MINUTES ?? 60)
const CHECK_INTERVAL_MS = 60_000

// Scale the Fargate service to zero after the room set has been empty for
// IDLE_MINUTES consecutive checks. Scaling to zero is data-safe by construction:
// an empty room set means every room was already flushed to S3 and closed on its
// last disconnect (see `leave` handling in rooms.ts), so there is nothing
// unsaved to lose when the task is stopped.
//
// OPEN ROOMS, NOT LAST ACTIVITY. A plan on a shared screen during a meeting can
// go twenty minutes without an edit; a last-activity clock would reclaim the task
// out from under the room. `getOpenRoomCount` is injected (rather than imported)
// to keep this module free of room internals.
export function startIdleShutdown(getOpenRoomCount: () => number): void {
	if (!CLUSTER) {
		console.log('[idle] ECS_CLUSTER unset — idle shutdown disabled (local/gate)')
		return
	}

	const ecs = new ECSClient({})
	let idleChecks = 0

	const timer = setInterval(async () => {
		if (getOpenRoomCount() > 0) {
			idleChecks = 0
			return
		}

		idleChecks += 1
		if (idleChecks < IDLE_MINUTES) return

		try {
			// The cluster holds exactly one service, with a CloudFormation-generated
			// name — discover it rather than hardcode the generated suffix.
			const { serviceArns } = await ecs.send(new ListServicesCommand({ cluster: CLUSTER }))
			const service = serviceArns?.[0]
			if (!service) return
			await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service, desiredCount: 0 }))
			console.log(`[idle] no open rooms for ${IDLE_MINUTES}m — scaled service to 0`)
		} catch (err) {
			// Failing safe means staying up (costs a little, breaks nothing). Back
			// the counter off by one so the next tick retries instead of hammering.
			console.error('[idle] failed to scale service to zero', err)
			idleChecks = IDLE_MINUTES - 1
		}
	}, CHECK_INTERVAL_MS)

	// Don't keep the event loop alive solely for this timer.
	timer.unref()
}
