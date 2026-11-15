# Keep the NAS copy always on

Status: Accepted, 2026-10-10

## Context and Problem Statement

Should the NAS copy of Timeline Studio scale to zero when idle? This is about the NAS copy only. The Source Allies copy on Fargate already scales to zero (`sync-server/src/idle-shutdown.ts` plus the `/wake` path in [`docs/deploying.md`](../deploying.md)) and is not measured or changed here.

Three containers run all the time in `homelab/nas-apps/timeline-studio/compose.yaml`, all `restart: unless-stopped`, all with a 60 s healthcheck:

- `web`: Caddy, the page and the `/api/*` split, published on 8085.
- `api`: the sync server. One process holds every open plan in memory and writes it to `s3` 3 s after a change (`SAVE_DEBOUNCE_MS`).
- `s3`: Versity Gateway v1.8.0 over plain files. One container only, because its put-if-absent locking is per process.

Compose has no scale-to-zero. The NAS box is on 24/7 regardless (Ryzen 5 5600GT, 12 threads, 30.65 GiB). Its idle draw is estimated at 55 to 85 W in `homelab/nas/docs/hardware.md` and has not been measured.

### What was measured

Source: Beszel v0.20.0 on the NAS (`container_stats` and `system_stats` for `exos-bay-one`), read through its own API in a signed-in browser, read-only. Window: the 2-hour tier, 2026-10-04 03:50Z to 2026-10-10 13:50Z (78 buckets for `web` and `api`, 76 from 2026-10-04 07:50Z for `s3`). Peaks come from the finer tiers: 20-minute (last 24 h), 10-minute (last 12 h) and 1-minute (last 80 min). Beszel averages each bucket, so a peak is only as sharp as its tier. CPU is a percentage of the whole host, not of a core: one fully busy thread reads 8.33.

| | CPU mean | CPU peak | Memory mean | Memory peak |
|---|---|---|---|---|
| `web` | <0.001% | 0.03% | 26.4 MiB | 64.3 MiB |
| `api` | 0.59% (0.28% on the quiet days 10-05 to 10-09) | 8.42% | 270.5 MiB | 1306 MiB |
| `s3` | <0.001% | 0.01% | 17.7 MiB | 33.5 MiB |
| all three | about 0.6% | 8.43% (2026-10-10 13:31Z) | about 315 MiB | 1377 MiB (2026-10-10 01:50Z) |

Host context for 2026-10-03 15:50Z to 2026-10-10 13:50Z: CPU mean 1.03%, p95 3.44%, highest bucket 7.81%. Memory used mean 3.18 GiB (10.4%), highest 15.5% of 30.65 GiB. Host disk I/O averaged 12 KB/s read and 244 KB/s write. The numbers were checked against the Beszel UI's 1-week view and match.

Daily network traffic through the three containers ranged from tens to a few hundred MB per quiet day. The two partial days (10-04 and 10-10) were far larger because of deploys and heavy use.

The falsifier did not fire. The claim "freeing these three containers frees nothing useful" would have been false if they used more than 10% CPU on average or more than 2 GiB resident. They use about 0.6% and peak at 1.35 GiB (4.4% of RAM). Their quiet floor is 279 MiB (`web` 46, `api` 205, `s3` 28), 0.9% of RAM. Those thresholds were chosen as about 1.2 threads and 6.5% of RAM: below that, the capacity is not worth a mechanism on a box that averages 1% CPU and 10% RAM.

### Idle share

A bucket counts as active if `api`'s sent plus received bytes average above 150 B/s, or its CPU is above 0.05%. The floor with nothing happening is about 88 B/s, which is the three 60 s healthchecks plus Uptime Kuma. The measured idle share was 30% in the 2 h tier (40% at a 1000 B/s cutoff), 45% over the last 24 h, 49% over the last 12 h and 30% over the last 80 min. Finer tiers read more idle, because a bucket with one burst counts as busy for its whole length.

- Deploys are in there. The deployer filed 23 production deployments in the window, each redeploying all three containers. About 14% of all buckets are busy because of a publish, and about 56% for some other reason.
- Only the small hours (about midnight to 04:00 Central) are mostly quiet. Evenings are mostly busy. On 10-09 a near-identical 1.5 MB cycle showed up at about :10 past most hours. It could not be identified, and nothing in `.github` is scheduled. Anything that does that hourly keeps a 60-minute idle timer from ever expiring.
- Uptime Kuma does not detect idleness here. Its `readyz` check agreed with Beszel's active/idle call in only 35 of 77 buckets, and in 38 of 42 disagreements Beszel showed traffic while Kuma showed nothing. The idle share rests on Beszel's network and CPU curves only.
- The number is probably an over-estimate of what scaling could use. An open but untouched tab keeps a socket and a room, and a socket costs a ping every 30 s, which is below the 88 B/s floor. So "quiet on the wire" includes time when `getOpenRoomCount` would not have been zero.

### What could not be measured

- Per-container disk I/O. Beszel's container record holds CPU, memory and network only. `s3`'s data directory is not readable by `truenas_admin`. The only size number is one ZFS point: `tank/apps/timeline-studio` references 44.5 MiB and uses 69.1 MiB with snapshots, on 2026-10-10.
- `s3` before 2026-10-04 (the earlier MinIO container is a different workload), and anything finer than the tiers above.
- Electricity. No wattmeter reading exists, so the 55 to 85 W figure is an estimate.
- Cold-start time on the NAS. Only the existing budgets are known: a 30 s start period on `web` and `api`, 10 s on `s3`, and the deployer's 90 s wait for the app to report its commit.
- Who the traffic is. Beszel cannot tell a person from a deploy from a forgotten tab.
- Two spells where `api` held one full thread (8.3 to 8.4% of the host, 1.1 to 1.3 GiB) for 25 to 40 minutes had no found cause. They are worth a look in `api`'s logs, and are not a reason to scale anything.

## Decision

Leave the NAS copy always on. Scaling it to zero when idle would free about 0.3 GiB of RAM and about 0.07 of one CPU thread on a machine that is on 24/7 anyway. It would cost a wake proxy, a root-level stop watcher and a deployer change to get there. No follow-up task is created.

Nothing is built and nothing in `homelab`, Beszel or Uptime Kuma was changed. The NAS keeps three warm containers and its deploys keep working as they are. Nothing here applies to the Source Allies copy.

Revisit when any of these becomes true, and take the numbers again first:

- The NAS gets a workload that wants the RAM or CPU, for instance host memory regularly above about 70% used (10% now) or host CPU mean above about 25% (1% now).
- The box can power down or suspend when idle (today it cannot). That is the only way scaling saves electricity.
- Idle-tab disconnect lands, the hourly cycle above is explained or removed, and a few weeks of data show the no-open-room share is large and steady. If it is still a wake proxy and a watcher for a few hundred MiB, the answer stays no.

## Alternatives Considered

- Stop on idle plus wake on request on the NAS: frees about 279 MiB at the quiet floor (0.9% of RAM) and about 0.07 of one thread averaged. A wake proxy has to stay up in front, and `web` alone is 46 MiB, so the net is nearer 230 MiB. Electricity is about zero because the box stays on. Even if one fully busy thread cost 10 W (an assumption), 0.07 of a thread is under 1 W. The risks are a cold start on the first visit after an idle spell (unmeasured, bounded below by the 30 s start periods) and data safety: plans are safe to stop only with no open room, and `api` has no SIGTERM flush that could be found in `sync-server/src`, so a stop must wait for zero rooms, not a quiet minute. Versity must be stopped after `api`, started before it, and kept to one container. The effort is a wake-on-request proxy on the published port 8085 (the front door reaches 8080 to 8099 only), a root watcher that stops and starts the TrueNAS app (the deployer is a root cron plus `midclt`, and `compose.yaml` alone cannot do it), healthchecks and the Kuma `readyz` check exempted so they do not wake it, and a deployer taught about it, because `deploy-job.sh` redeploys all three containers on every publish and waits up to 90 s for `/api/health` to report the new commit. That is four new moving parts on a box that has none of them. Rejected.
- Reuse `idle-shutdown.ts` on the NAS: not possible as it is. The loop is worth keeping (count consecutive minutes with `openRoomCount() == 0`; stopping then is data-safe because every room was flushed on its last disconnect). The action does not carry over. `ListServices` and `UpdateService` are ECS calls, the code is gated on `ECS_CLUSTER` (unset on the NAS), and a process inside `api` cannot stop its own container (`restart: unless-stopped` starts it again) and cannot stop `web` or `s3`. A NAS version needs a second backend outside the container. `GET /api/rooms` already returns `{ openRooms }` and the page already posts `wake` before its first request, so what remains is the watcher, the wake handler and the privileged start and stop.
- Idle-tab disconnect (`ts-idle-tab-disconnect`): makes "no open rooms" a truer idle signal and would make a scale-down measurement honest, but changes nothing on the cost side, so it does not change the verdict.

## More Information

- Rewritten 2026-11-13 from ADR 0022; alternatives reconstructed from code and history where the original did not record them.
