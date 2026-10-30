# Transcode benchmark

Command: `SECONDS=20 VIDEOS=4 THREADS=2 npx tsx scripts/bench-transcode.ts` (see the script header for env vars).

## Setup

- Machine: Intel Core i5-8365U (4 cores, 8 threads), 8 GB RAM, laptop. Local SeaweedFS S3, Redis 7.4.1, Mongo 8.2 and the workers all ran on the same machine, so they compete for CPU.
- Source: 20 s of 1920x1080, 25 fps synthetic video (ffmpeg `testsrc2`) with a sine tone. Synthetic content is not real footage, so absolute encode times will differ on real video.
- Each run: 4 videos, each encoded to 4 renditions (1080, 720, 480, 360) with libx264 `veryfast`, so 16 encode jobs. All jobs are enqueued at once.
- Workers: separate processes, one encode job at a time each, `ffmpeg -threads 2` per job.
- One run per worker count. No repeats, so run-to-run variation is unknown.

## Results

| Workers | Wall time | Video seconds per wall second | Speed-up | Mean time per encode job | Queue wait p50 | Queue wait p95 |
|---|---|---|---|---|---|---|
| 1 | 254.2 s | 0.31 | 1.00x | 15.8 s | 115.9 s | 242.6 s |
| 2 | 159.7 s | 0.50 | 1.59x | 19.9 s | 66.6 s | 145.6 s |
| 4 | 135.1 s | 0.59 | 1.88x | 32.4 s | 47.2 s | 107.8 s |

No job failed in any run.

## Reading it

- More workers help, but not linearly. Four workers at two threads each want 8 threads, which is every hardware thread on this CPU, and S3, Redis, Mongo and the uploads need CPU too. The mean time per job doubling from 1 to 4 workers shows the machine is saturated. A machine with more physical cores should scale further.
- Cost of one rendition at one worker: about 15.8 s of wall time per 20 s of video, mixed across the four rungs. That is roughly 47 s per minute of video per rendition at two threads. Wall time, not measured CPU time.
- Queue wait is inflated on purpose: all 16 jobs arrive together. It shows how deep the backlog gets, not what a user would see under a steady load.
- The numbers say nothing about the free-tier hosts. Render's free instance has far less CPU than this laptop.

# Key route and playback start

Command: `REDIS_URL=redis://127.0.0.1:6390 npx tsx scripts/bench-keys.ts` (add `NO_ANALYTICS=1` to leave out event writes and flag rules). Defaults: 50 viewers, 40 key requests each.

## Setup

- Same laptop as above (i5-8365U, 8 threads, 8 GB), Node 22.14. The API, an in-memory Mongo, Redis 7.4.1 and the load generator all run on it, so they compete for the same CPU. A real deployment spreads them out.
- Storage is not involved: the key route reads Mongo and Redis only.
- One video of 2 hours, so 240 keys. Each viewer holds its own playback token and lease. Requests use the real routes with real tokens.
- "Playback start": all 50 viewers start at once (session check, access check, Redis lease, token, event write).
- "Key request": the 50 viewers each ask for 40 keys back to back, all at once. Each request checks the token, the viewer's access in Mongo, the lease in Redis, reads the key, writes an event and runs the flag rules. This is a closed loop, so the latency is mostly queueing: with 50 requests always in flight, latency is about 50 divided by the throughput.
- Two runs per setting. The per-address key limit is lifted for the run (`KEYS_PER_MIN`).

## Results

Times in milliseconds.

| Run | Requests | per second | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| playback start, with analytics, run 1 | 50 | 72 | 460.8 | 636.8 | 652.9 | 652.9 |
| playback start, with analytics, run 2 | 50 | 75 | 425.2 | 625.2 | 629.0 | 629.0 |
| playback start, no analytics, run 1 | 50 | 108 | 310.3 | 419.2 | 421.5 | 421.5 |
| playback start, no analytics, run 2 | 50 | 104 | 331.2 | 441.7 | 444.1 | 444.1 |
| key request, with analytics, run 1 | 2000 | 127 | 368.0 | 561.4 | 659.5 | 1097.5 |
| key request, with analytics, run 2 | 2000 | 128 | 365.7 | 528.3 | 638.4 | 1018.5 |
| key request, no analytics, run 1 | 2000 | 218 | 215.0 | 290.2 | 404.1 | 868.9 |
| key request, no analytics, run 2 | 2000 | 235 | 198.1 | 301.8 | 426.8 | 750.7 |

No request failed. A first run with analytics, taken before the two above, gave 124 per second and p50 382.3 ms for keys.

## Reading it

- On this machine the key route handled about 125 requests per second with the event and flag work on, and about 220 to 235 without it. So that work costs roughly 40 percent of the throughput here. It is two Mongo writes and a read per request (an event insert, a 60 minute event query for the rules, and a flag upsert when a rule is already firing).
- Context for the number: a viewer asks for one key every 30 seconds. 125 per second is the rate of about 3,700 viewers playing at the same time. That is arithmetic, not a measurement of 3,700 viewers.
- The load here is harsher than real use: every viewer in this script asks for keys far ahead of a playhead that never moves, so the flag rules fire all the time and the flag upsert runs on most requests. A normal viewer does less work per request.
- Not measured: a second API process, Atlas instead of local Mongo, a Redis over the network, or any hosted free tier. Those will all be slower on latency than loopback.
