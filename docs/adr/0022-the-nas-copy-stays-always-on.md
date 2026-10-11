# The NAS copy stays always-on

2026-10-10. **Verdict: don't.** Scaling the NAS copy of Timeline Studio to zero when idle would free about 0.3 GiB of
RAM and about 0.07 of one CPU thread on a machine that is on 24/7 anyway, and it would cost a wake proxy, a root-level
stop watcher and a deployer change to get there. **Do it later only if** the NAS becomes short of RAM or CPU (see
"Revisit when"), or the box becomes able to sleep. No follow-up task is created.

This is about the NAS copy only. The Source Allies copy on Fargate already scales to zero
(`sync-server/src/idle-shutdown.ts` plus the `/wake` path in [`docs/deploying.md`](../deploying.md)) and is not
measured or changed here.

## What runs today

Three always-on containers in `homelab/nas-apps/timeline-studio/compose.yaml`, all `restart: unless-stopped`, all with a
60 s healthcheck:

- `web`: Caddy, the page and the `/api/*` split, published on 8085.
- `api`: the sync server. One process holds every open plan in memory and writes it to `s3` 3 s after a change
  (`SAVE_DEBOUNCE_MS`).
- `s3`: Versity Gateway v1.8.0 over plain files. One container only: its put-if-absent locking is per process.

Compose has no scale-to-zero. The NAS box is also on 24/7 regardless (Ryzen 5 5600GT, 12 threads, 30.65 GiB). Its idle
draw is estimated at 55-85 W in `homelab/nas/docs/hardware.md` and has not been measured.

## What was measured

Source: Beszel v0.20.0 on the NAS, `container_stats` and `system_stats` for `exos-bay-one`, read through its own API in
a signed-in browser, read-only. Window: the 2-hour tier, **2026-10-04 03:50Z to 2026-10-10 13:50Z** (78 buckets for
`web` and `api`; 76 from 2026-10-04 07:50Z for `s3`). Peaks come from the finer tiers: 20-minute (last 24 h), 10-minute
(last 12 h) and 1-minute (last 80 min). Beszel averages each bucket, so a peak is only as sharp as its tier.

CPU is a percentage of the **whole host**, not of a core: the host has 12 threads, so one fully busy thread reads 8.33,
and `api` sat at 8.35-8.42 for long stretches (the host's own CPU read about 9.5 in the same minutes).

| | CPU mean | CPU p95 (2 h buckets) | CPU peak | Memory mean | Memory peak |
|---|---|---|---|---|---|
| `web` | <0.001% | 0.00% | 0.03% (10 min tier) | 26.4 MiB | 64.3 MiB (10 min tier) |
| `api` | 0.59% (0.28% on the quiet days 10-05 to 10-09) | 3.04% | 8.42% (10 min tier; 7.46% in a 2 h bucket) | 270.5 MiB | 1306 MiB (20 min tier, 2026-10-10 ~01:50Z) |
| `s3` | <0.001% | 0.00% | 0.01% | 17.7 MiB | 33.5 MiB (20 min tier) |
| the three together | ~0.6% | | 8.43% (1 min tier, 2026-10-10 13:31Z) | ~315 MiB | 1377 MiB (20 min tier, 2026-10-10 01:50Z) |

Network, bytes sent / received by each container, summed from the 2 h tier per UTC day (MB). The two partial days are
marked; days 10-05 to 10-09 are complete.

| | 10-04 (from 03:50Z) | 10-05 | 10-06 | 10-07 | 10-08 | 10-09 | 10-10 (to 13:50Z) |
|---|---|---|---|---|---|---|---|
| `web` out / in | 219 / 299 | 48 / 40 | 45 / 33 | 77 / 66 | 62 / 51 | 55 / 41 | 902 / 2531 |
| `api` out / in | 710 / 215 | 122 / 25 | 68 / 43 | 163 / 113 | 139 / 86 | 79 / 60 | 3109 / 2589 |
| `s3` out / in | 197 / 386 (from 07:50Z) | 24 / 87 | 42 / 39 | 111 / 101 | 85 / 92 | 58 / 42 | 2583 / 606 |

`api`'s traffic to `s3` shows up on both sides (its sent bytes match `s3`'s received), so the three rows do not add up
to the NAS's traffic. Host context from the same tier (2026-10-03 15:50Z to 2026-10-10 13:50Z): CPU mean 1.03%, p95
3.44%, highest bucket 7.81%; memory used mean 3.18 GiB (10.4%), highest 15.5% of 30.65 GiB. Host disk I/O averaged
12 KB/s read and 244 KB/s write.

Checked against the Beszel UI (1-week view of the system page, 2026-10-10): the host CPU axis tops out at 7.8%, matching
the 7.81% bucket; the Docker CPU chart tops out at 7.6% on 10-04/05, matching `api`'s 7.46% bucket plus the small
containers; Docker memory peaks near 1.5 GB for all containers around the same time, consistent with `api`'s 1131 MiB
bucket plus the others; the memory axis runs to 31 GB, matching 30.65 GiB.

**The falsifier did not fire.** The claim "freeing these three containers frees nothing useful" would have been false if
they used more than 10% CPU on average or more than 2 GiB resident. They use about 0.6% and peak at 1.35 GiB (4.4% of
RAM); their quiet floor is 279 MiB (`web` 46, `api` 205, `s3` 28), 0.9% of RAM. Those two thresholds were chosen as
about 1.2 threads and 6.5% of RAM: below that, the capacity is not worth a mechanism on a box that averages 1% CPU and
10% RAM. `api` is a bigger share of what the host actually spends (0.59 of 1.03 points of CPU), but the host spends very
little.

## What could not be measured

- **Per-container disk I/O.** Beszel's container record holds CPU, memory and network only (`c`, `m`, `b` in v0.20.0's
  `container.go`). Disk is host-level: read 12 KB/s and write 244 KB/s on average, with `api`, Kuma, Beszel and ZFS
  all mixed in. `s3`'s data directory is not readable by `truenas_admin` (`/mnt/tank/apps/timeline-studio/s3` is
  `apps:apps 0750`; I did not escalate). The only size number available is a single point from ZFS:
  `tank/apps/timeline-studio` references 44.5 MiB and uses 69.1 MiB with snapshots, on 2026-10-10. There is no growth
  series.
- **`s3` before 2026-10-04.** Versity has six days of history. The MinIO container before that is a different workload,
  and Beszel holds nothing for the Timeline Studio containers before 2026-10-04 03:50Z anyway. Nothing is spliced in.
- **Sub-minute and sub-bucket behaviour.** The finest tier covers only the last 80 minutes. Everything older is a 10
  minute, 20 minute or 2 hour average, so a one-minute burst inside a 2 h bucket is invisible, and a bucket's CPU peak is
  an average, not a peak.
- **Beszel's 30-day window is real but unused.** Beszel keeps the 8-hour tier for 30 days (720 h in v0.20.0's deletion
  code; 1 h for the 1-minute tier, 12 h, 24 h and 7 days for the others). This hub only began collecting on 2026-09-28,
  so the cap has not been reached. The Timeline Studio containers started on 2026-10-04.
- **Uptime Kuma's 180 days.** That is a ceiling. The two Timeline Studio monitors (the public URL and the NAS `readyz`
  check, both every 60 s) were created on 2026-10-04, so they hold about 6.5 days. I read Kuma's hourly aggregates
  (min, average, max) through its own chart call, not the raw database. Its SQLite file under
  `/mnt/tank/apps/uptime-kuma` is not readable by `truenas_admin` either.
- **Electricity.** No wattmeter reading exists; the 55-85 W figure is an estimate. See the cost section for the bound.
- **Cold-start time on the NAS.** Not measured. Only the existing budgets are known: a 30 s start period on `web` and
  `api`, 10 s on `s3`, and the deployer's 90 s wait for the app to report its commit. The AWS copy's 30-90 s is a
  different stack.
- **Who the traffic is.** Beszel cannot tell a person from a deploy from a forgotten tab. See below for what could be
  attributed.

## Idle share

**Method.** A bucket counts as active if `api`'s sent plus received bytes average above 150 B/s, or its CPU is above
0.05%. The floor with nothing happening is about 88 B/s (`api` 52 sent, 36 received), which is the three 60 s
healthchecks plus Kuma. Raising the cutoff to 300 B/s changes nothing and to 1000 B/s moves the 2 h figure from 30% to
40% idle. I used `api` because every request that does anything reaches it. I did not use `web` or `s3` on their own:
`web` also serves static files and `s3` also answers `api`'s own flushes.

| Tier | Window | Buckets | Idle |
|---|---|---|---|
| 2 h | 10-04 05:50Z to 10-10 13:50Z | 77 | 30% (40% at a 1000 B/s cutoff) |
| 20 min | last 24 h | 74 | 45% |
| 10 min | last 12 h | 75 | 49% |
| 1 min | last 80 min | 84 | 30% |

Finer tiers read more idle, because a bucket with one burst in it counts as busy for its whole length. The 1-minute row
is a busy Saturday morning and is not a typical stretch.

**Deploys are in there.** The deployer filed 23 production deployments in the window (GitHub Deployments on
RascalTwo/timeline-studio): 15 on 10-04, 5 on 10-05, one on 10-07 and one on 2026-10-10 at 02:04Z. Each one redeploys all
three containers. Eleven of the 54 active 2 h buckets contain a deploy, so about 14% of all buckets are busy because of
a publish and about 56% for some other reason. After the 10-10 02:04Z deploy there is a ~2.5 h stretch (02:40Z to 04:50Z)
of 80-420 KB/s through `web` and `api` that I could not attribute: it may be the first-open schema upgrade
(`docs/deploying.md`), or a person, and Beszel cannot say which.

**When.** Idle runs in the 2 h tier: 9 of them, the longest 10 h (10-05 about 11:50Z to 21:50Z, a Monday daytime in
Central time), then 8 h (10-06 01:50Z to 09:50Z, the small hours), and the rest 4 to 6 h. The latest, 04:50Z to 10:50Z
on 10-10, is 6 h in the 20-minute tier. Only the small hours (about midnight to 04:00 Central) are mostly quiet (a bucket centred on 01:00
or 03:00 Central was active in 2 of 7 and 1 of 7 buckets); the rest of the day, evenings included, is mostly busy, with a small morning visit
(about 300-600 B/s in the 09:50Z to 11:50Z bucket on each of 10-06 to 10-09). On 10-09 from 14:10Z until about 00:30Z on 10-10 (all the 20-minute tier covers
of that day) the buckets show a near-identical ~1.5 MB cycle at about :10 past most hours (the same byte counts each time). I could not identify
what makes it, and nothing in `.github` is scheduled. Anything that does that every hour keeps a 60-minute idle timer
from ever expiring.

**Kuma does not detect idleness here, and I did not average it in.** Kuma's `readyz` check (local, 60 s) averages 3.3 ms
and rises to 3.7-4.4 ms only in the heaviest windows (10-04 19:00Z to 23:00Z, 10-10 01:00Z to 04:00Z and 11:00Z to
14:00Z). Compared bucket by bucket with Beszel's active/idle call (`readyz` at or above 3.6 ms against active), the two
agree in 35 of 77 buckets (45%). In 38 of the 42 disagreements Beszel shows traffic and Kuma shows nothing, so Kuma's
response time cannot see light use; in the other four Kuma blips with no traffic. The public URL check (about 290 ms) is
noisier still: it throws 4.3-11.5 s samples in quiet buckets (10-09 06:00Z had a 4446 ms sample while `api` was at its
88 B/s floor), which is the path through the Lightsail front, not load. By the rule written for this task (activity in
windows Kuma calls quiet makes the estimate unreliable), the idle share above stands on Beszel's network and CPU curves
only, and Kuma serves as a cross-check for heavy bursts, nothing more.

**It is probably an over-estimate of what scaling could use.** An open but untouched tab keeps a socket and a room, and
a socket costs a ping every 30 s, which is below the 88 B/s floor. So "quiet on the wire" includes time when
`getOpenRoomCount` would not have been zero. The usable share is at most the number above, and the next section says why
it also needs deploys, healthchecks and the hourly cycle to stay out of the way.

Two things the curves show that are not idle at all: `api` held one full thread (8.3-8.4% of the host, 1.1-1.3 GiB) for
at least 25 consecutive minutes (10-10 13:09Z to 13:34Z) and for about 40 minutes (01:30Z to 02:10Z) the same day. I did
not find the cause. It is worth a look in `api`'s logs separately; it is not a reason to scale anything.

## Options

| | Cost | Risk | Effort |
|---|---|---|---|
| **Leave it always-on** (chosen) | Nothing changes. | Nothing new. Warm every time. | None. |
| **Stop-on-idle plus wake-on-request on the NAS** | Frees about 279 MiB at the quiet floor (0.9% of RAM) and about 0.07 of one thread averaged. A wake proxy has to stay up in front, and `web` alone is 46 MiB, so the proxy would cost about as much as the container it replaces; the net is nearer 230 MiB. **Electricity is about 0:** the box stays on. Even if one fully busy thread cost 10 W (an assumption, not a measurement), 0.07 of a thread is under 1 W. | A cold start on the first visit after an idle spell, unmeasured on the NAS and bounded below by the 30 s start periods; today it is always warm. Plans are safe to stop only with no open room, and `api` has no SIGTERM flush that I could find (`grep` of `sync-server/src`), so a stop must wait for zero rooms, not just a quiet minute. Versity must be stopped after `api` and started before it, and kept to one container. | A wake-on-request proxy on the published port 8085 (the front door reaches 8080-8099 only); a root watcher that stops and starts the TrueNAS app (the deployer is a root cron plus `midclt`; `compose.yaml` on its own cannot do it); the healthchecks and Kuma's `readyz` check exempted so they do not wake it; **the deployer taught about it**, because `deploy-job.sh` pulls and redeploys all three containers on every publish and then waits up to 90 s for `/api/health` to report the new commit, so a sleeping app would be woken or mis-reported on every deploy. Four new moving parts on a box that has none of them. |

## What `ts-idle-tab-disconnect` changes, and `idle-shutdown.ts`

`ts-idle-tab-disconnect` makes "no open rooms" a truer idle signal, because a visible but untouched tab would stop
counting. That shrinks the gap noted above between "quiet on the wire" and "no open room" and makes a scale-down
measurement honest. It changes nothing on the cost side, so it does not change the verdict.

`idle-shutdown.ts` cannot be reused on the NAS as it is. The part worth keeping is the loop and its reasoning: count
consecutive minutes with `openRoomCount() == 0`, and stopping then is data-safe because every room was flushed on its
last disconnect. The part that does not carry over is the action: `ListServices` and `UpdateService` are ECS calls, the
whole thing is gated on `ECS_CLUSTER` (unset on the NAS, so it is a no-op there today), and a process inside `api` cannot
stop its own container, since `restart: unless-stopped` would just start it again, and cannot stop `web` or `s3` at all.
A NAS version needs a second backend that lives outside the container. `GET /api/rooms` already returns
`{ openRooms }`, so an external watcher could poll it, and the page already posts `wake` before its first request, so
the browser side exists. What would still have to be written is the watcher, the wake handler behind that path, and
the privileged start/stop.

## Revisit when

Reopen this if any of these becomes true, and take the numbers again first:

- the NAS gets a workload that wants the RAM or CPU, for instance host memory regularly above ~70% used (it is 10% now)
  or host CPU mean above ~25% (it is 1% now);
- the box can power down or suspend when idle (today it cannot), which is the only way scaling saves electricity;
- `ts-idle-tab-disconnect` lands, the hourly cycle above is explained or removed, and a few weeks of data show the
  no-open-room share is large and steady. If it is still a wake proxy and a watcher for a few hundred MiB, the answer
  stays no.

## Consequences

Nothing is built and nothing in `homelab`, Beszel or Uptime Kuma was changed. The NAS keeps three warm containers and
its deploys keep working as they are. Nothing here applies to the Source Allies copy.
