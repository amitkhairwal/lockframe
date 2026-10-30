# Video infrastructure: plan

Name: lockframe.

Source: project 06 in the "7 projects" slides and the matching part of the video.
We build one phase at a time. A phase starts only after the previous one passes its gates.

## 1. What we build

A video platform backend with a small React front end. A user uploads a large video
and the upload survives a dropped connection. Workers turn it into an HLS ladder
(4 renditions, AES-128 encrypted, keys rotated during the video). The player only gets
keys through a short-lived signed token, with a one-device limit and a moving viewer
watermark. The transcript is searchable, and a question like "where are closures
explained?" jumps to the exact timestamp.

The slide's pipeline is the spine of the project:
upload, transcode, encrypt, deliver, understand.

## 2. What the video and slide ask for

Taken from the video transcript and the blueprint in the HTML.

| Requirement | Source | Phase |
|---|---|---|
| Multipart, resumable uploads, resume after a cut connection | video + blueprint | 1 |
| Object storage ingest | blueprint | 1 |
| Transcoding job queue, N workers | blueprint | 2 |
| FFmpeg resolution ladder, 4+ renditions | blueprint | 2 |
| HLS (and DASH) packaging | video + blueprint | 2 |
| Signed playback authorization | video + blueprint | 3 |
| Viewer watermark | video | 3 |
| Device controls | blueprint | 3 |
| Playback analytics and watch progress | video + blueprint | 5 |
| Speech to text and subtitles | video + blueprint | 4 |
| Chapters and topics with timestamps | video + blueprint | 4 |
| Semantic search | video | 4 |
| Video-grounded Q&A | video + blueprint | 4 |
| Summaries of suspicious playback patterns | video + blueprint | 5 |
| Stack: React, TS, Node, MongoDB, Redis, BullMQ, FFmpeg, S3, CDN, HLS.js, LLM | blueprint | all |
| Architecture diagram, benchmarks, tradeoff notes, failure demo, security notes, readable README | closing slide | 6 |
| Demo: start a big upload, kill the network, resume, watch workers, search, jump | blueprint | 6 |
| Never claim scale you did not test | closing slide | all |

DASH: the blueprint says HLS/DASH. We ship HLS only and say so. A second packager adds
little an interviewer can probe.

## 3. Decisions

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript on Node 22 | The video's stack. Same as Relay, so tooling is reused. |
| API | Fastify | Small, fast, typed schemas. |
| DB | MongoDB Atlas M0 | The blueprint says Mongo for this one. Scrawl already uses Atlas. No Neon compute-hour limit. |
| Queue | BullMQ on Redis | The blueprint's pick. Flows give the probe, renditions, package, transcribe chain. |
| Storage | S3 API only, behind a tiny adapter | Any S3-compatible host works. Local S3 server for dev and tests. |
| Upload | S3 multipart with presigned part URLs | Browser sends parts straight to storage. The API only signs and tracks. |
| Upload integrity | Per-part checksum signed into the part URL | Size checks alone let a corrupted part through. Storage rejects a part whose bytes do not match. |
| Encryption | HLS AES-128 applied by the worker after ffmpeg, key rotated every 5 segments (30 s), keys kept in Mongo, never in the bucket | ffmpeg's own rotation needs the key file rewritten while it runs. Encrypting finished segments in Node (AES-128-CBC, IV is the segment number) is deterministic and no plaintext segment ever reaches storage. Rotation means the player keeps asking for keys, so the device limit bites during playback, not only at start. |
| Key auth | hls.js `xhrSetup` adds the playback token to key requests only. Key URLs in the playlists are absolute, built from `KEY_URL_BASE` at encode time | Playlists stay static files, no rewriting per viewer. Cost: moving the API to another host means rewriting the small playlists. Only players we control can play, which is the point. |
| Delivery | Playlists and segments from `HLS_BASE_URL` (a public bucket or CDN in production). In dev the API serves `/media/...` straight from storage | Everything under hls/ is encrypted, so it needs no auth. On Render free the proxy would eat the bandwidth quota, so production must use a bucket or CDN. |
| Player | hls.js | In the stack list. |
| Realtime | Socket.io for job progress | Already used in Scrawl. |
| STT | Provider interface. Default: hosted Whisper API. Local whisper.cpp as fallback | Needs an API key from you, see section 9. |
| Q&A and chapters | One LLM call over retrieved chunks, must cite timestamps | Answers are checkable. No chunk found means "not in this video", not a guess. |
| Search | Mongo text index first, then Atlas vector search | Works with zero keys on day one. Vectors are an upgrade. |
| Auth | Email + password, JWT in an httpOnly cookie, owner and invited viewers | Premium content needs real access control. Lands before anything is deployed. |
| Repo | One repo: apps/api, apps/worker, apps/web, shared | Worker is its own process so it can be scaled and killed in demos. |

## 4. Shape of the system

```
browser --(sign part urls)--> API --> Mongo (users, videos, uploads, keys, transcripts, events)
   |                           |
   |--(PUT parts)--> S3        +--> BullMQ (Redis) --> worker(s)
                                                      probe -> renditions (parallel)
                                                      -> master playlist -> audio
                                                      -> transcribe -> chunk + index
player --(playlists, segments)--> S3 / CDN
player --(key request + playback token)--> API --> Redis device lease
```

### Video lifecycle

`uploading -> uploaded -> processing -> ready`, or `failed` with a reason the owner can
see. `deleting` removes every object under the video's prefix, then the record.
Each stage writes timestamps, which later feed the benchmark table.

### Data (Mongo)

- users: email, password hash, createdAt
- videos: owner, title, status, failure reason, duration, source height, renditions, stage timings, viewers (emails)
- uploads: as built in phase 1, plus owner
- keys: video, index, 16 key bytes, iv. Read only by the key route
- transcripts: video, chunk start, end, text, embedding (phase 4)
- playback_events: video, viewer, device, type, position, at (phase 5, TTL index so it does not fill M0)
- flags: video, viewer, rule, evidence, summary (phase 5)

### Transcode details that matter

- Every rendition uses the same fixed GOP (`-g` = 2 x fps, `-sc_threshold 0`) and 6 s
  segments. Without aligned keyframes, switching quality mid-play stutters.
- Ladder capped at the source height. A 720p source gets 720, 480, 360, not a fake 1080.
- The worker reads the source through a presigned URL straight into FFmpeg, and writes
  segments to a temp dir it deletes in `finally`. Render's free disk is small.
- Job ids are `videoId:stage`, so a retry replaces its own output instead of duplicating it.
- SIGTERM kills the FFmpeg child and leaves the job for another worker.
- ffprobe is the real file check. A non-video upload ends as `failed` and its raw file is deleted.
  The client's content type is never trusted.

### Playback security

A token is minted per viewer and per video (2 min life, refreshed by the player).
The key route checks the token, the viewer's access, and a Redis device lease
(one active device, TTL refreshed by heartbeat; a second device is refused until the
lease lapses). Keys rotate during the video, so a stolen early key does not unlock
the rest. Leaking a segment URL gives nothing.

Honest limit: AES-128 with gated keys is not DRM. A viewer with dev tools can still
collect keys while watching, and anyone can screen record. The moving watermark with
the viewer's email is a deterrent. The README says this plainly.

### Rough API

- POST /api/auth/signup, POST /api/auth/login, POST /api/auth/logout
- POST /api/uploads, GET /api/uploads/:id/parts, POST /api/uploads/:id/parts/:n/url, POST /api/uploads/:id/complete, DELETE /api/uploads/:id
- GET /api/videos, GET /api/videos/:id, DELETE /api/videos/:id, POST /api/videos/:id/viewers
- POST /api/videos/:id/playback, GET /hls/:id/key/:n
- POST /api/videos/:id/heartbeat
- GET /api/search?q=, POST /api/videos/:id/ask
- GET /api/admin/flags
- GET /healthz (never touches the DB, so uptime pings cost nothing)

Resume rule: storage's ListParts is the source of truth, not our DB. After a crash
the client asks which parts exist and sends only the missing ones.

## 5. Phases

Each phase ends with its own gates file under `gates/` and a runnable check.
Each phase also ships the web screen for its feature, so the demo grows with the backend.

1. **Resumable upload.**
   - Built: multipart API, part tracking from ListParts, size check on complete, abort,
     stale sweep, resumable client with retries, 10 tests on a fake storage.
   - Left: real S3 run of `scripts/upload-check.ts` (cut at about 50 percent, resume,
     sha256 match), per-part checksum, bucket CORS (allow PUT, expose ETag), bucket
     lifecycle rule that aborts incomplete uploads after 2 days, upload page with
     progress, pause and resume. A browser cannot reopen a file after a reload, so
     the page asks for the same file again and resume picks up from the fingerprint.
2. **Auth.** Moved up from phase 3. Signup, login, owner on uploads and videos, invited
   viewers, rate limit on auth and upload creation. Nothing gets deployed before this.
3. **Queue and transcode.** BullMQ flow, ffprobe check, aligned ladder, HLS playlists,
   progress over Socket.io, retries, failed state shown to the owner, delete video.
   Exit check: kill a worker mid-transcode, the video still reaches ready. Throughput
   measured with 1, 2 and 4 workers on the same test file.
4. **Secure playback.** Key rotation, playback token, key route, device lease, heartbeat,
   watermark overlay, player page. Exit check: a key request with no token, an expired
   token, a non-viewer, or a second device is refused.
5. **Understand.** Audio extract (16 kHz mono, split into pieces under the provider's size
   limit with a small overlap), transcription with timestamps, WebVTT subtitles, chunks of
   about 30 to 60 s, chapters, text search then vector search, Q&A with timestamp
   citations and a "not found" answer. Rate limit on LLM calls. Exit check: 10 labeled
   questions on one test video, hit rate reported as measured.
6. **Analytics and flags.** Watch progress and resume position, playback events,
   rule-based suspicious patterns (many devices, repeated replays, key requests far
   ahead of the playhead) with an LLM-written summary of each flag.
7. **Prove it.** Architecture diagram, benchmark table, tradeoff notes, failure demo
   script, security notes, README, short screen recording.
8. **Ship.** Dockerfile and compose, a CI job that builds and runs the compose stack
   with a smoke test (Docker is not on this machine, so CI is the honest check), deploy,
   live link, resume bullets, interview sheet.

## 6. Tests

- Unit and integration tests with Vitest, Mongo in memory, a local S3 server.
- Transcode tests use clips made by FFmpeg itself (`testsrc` plus a sine tone), a few
  seconds long, so they run in CI.
- Each phase's gates file holds the command that proves it.

## 7. What we measure and may claim

Only numbers we run ourselves, with the setup written next to them.

- Upload: largest interrupted-then-resumed file, and bytes re-sent after the cut.
- Transcode: seconds per minute of video per rendition, and scaling with 1/2/4 workers.
- Queue: p95 wait before a job starts (from the stage timestamps).
- Playback: time to first frame on the deployed link, warm, p50 and p95. Render's
  cold start is stated separately, not hidden in the number.
- Search: hit rate on the labeled question set.

The slide's 8 GB and under-2 s startup are the author's targets, not ours. The disk
here has room for a multi-GB test, so a large number is possible locally. The deployed
demo is capped (clip length and size) and the README says so.

## 8. Free-tier reality and risks

- **Render free (512 MB, shared CPU, sleeps when idle):** FFmpeg on it is slow. The live
  site serves pre-processed demo videos and allows only small uploads. Workers can also
  run on this machine against the cloud Redis and storage, which is a real scaling demo.
- **Redis host:** BullMQ polls. A host that bills per command (the Upstash free plan) can
  burn its monthly quota fast, the same trap as Relay's polling. Prefer a memory-capped
  host with no command cap. The device lease lives in Redis too, so the live demo
  depends on it.
- **Storage host:** Cloudflare R2 has the best free tier, but I believe it asks for a
  payment method (not checked). Fallbacks that speak S3: Backblaze B2, Supabase Storage.
  Per-part checksums, CORS and lifecycle rules differ between hosts, so the phase 1 check
  must run against the host we actually deploy on.
- **Atlas M0 is 512 MB:** fine for transcripts and embeddings of a few demo videos.
  Playback events get a TTL so they do not fill it.
- **LLM and STT keys:** free tiers have rate limits. Results are stored, never re-run
  for the same video.
- **Docker:** not available here. Compose files are verified in CI.
- **Demo content:** a long video with clear speech. Your own recording, or public domain
  or CC0. Nothing copyrighted.
- **No hosting tricks:** one deployment, one live link.

## 9. What I need from you

Defaults are picked so nothing blocks. Change any of them.

1. Name: lockframe (chosen).
2. A local S3 server for tests: allow downloading the SeaweedFS release binary, or give
   a real bucket (keys go in `.env`, never in chat).
3. Transcription and LLM: a free key (Groq or Gemini, no card) by phase 5, or phase 5
   runs on local whisper.cpp and the LLM part waits.
4. A 15 to 30 minute demo video with speech.
5. Commits and pushes stay with you, as usual.

## 10. Not doing

DASH, real DRM (Widevine and friends), live streaming, payments, a mobile app,
per-viewer burned-in forensic watermarking, multi-region CDN. Each is real work and
none is needed for the claims above.
