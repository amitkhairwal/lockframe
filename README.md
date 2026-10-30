# lockframe

A video platform backend and player I built to learn how the hard parts work: resumable uploads, a transcode queue, encrypted streaming with controlled key access, and an AI layer on top (transcripts, search, questions with citations, and flags for odd viewing).

It is a working project, not a product. [What is not done](#not-done-or-not-measured) is listed below.

Architecture diagram: open [`docs/diagram/architecture.html`](docs/diagram/architecture.html) in a browser. It is an interactive page, not an image.

## What it does

- **Upload.** Large files go straight to S3 in parts. Each part carries a signed SHA-256, so storage refuses corrupt bytes. A closed tab or lost connection resumes from the parts already stored.
- **Process.** Probe, encode (one job per rendition: 1080, 720, 480, 360 as far as the source goes) and finalize run on BullMQ. A worker killed mid-encode loses its lock and another worker finishes the job. Progress reaches the owner live over Socket.io.
- **Play.** HLS with AES-128. Segments are encrypted before they are stored, keys rotate every 30 s and are handed out only by a key route that checks a short-lived token, the viewer's current access, and one active device slot. A moving watermark shows the viewer's email.
- **Understand.** After a video is ready, speech to text, chapters and a search index are built in the background. Search and questions point at the exact sentence. An answer has to cite a real excerpt or the system says it did not find one. Needs a Groq key; without one the rest works and these routes answer 503.
- **Watch.** Resume position, play/pause/seek events, and rules that flag odd behaviour (second-device attempts, many replays, keys requested far ahead of the playhead, key bursts) for the video owner.

Stack: TypeScript on Node 22, Fastify, MongoDB, BullMQ on Redis, S3 API, ffmpeg, Socket.io, React with hls.js.

## Run it

You need Node 22, ffmpeg and ffprobe on PATH, MongoDB, Redis and an S3 compatible server. `docker compose up` also starts the whole stack (see `docs/DEPLOY.md`; not run locally, CI runs it).

```
npm install
export S3_ENDPOINT=http://127.0.0.1:8333 S3_BUCKET=lockframe S3_ACCESS_KEY=... S3_SECRET_KEY=...
export REDIS_URL=redis://127.0.0.1:6379
export MONGODB_URI=mongodb://127.0.0.1:27017/lockframe
npm run bucket:setup      # CORS and the cleanup rule for unfinished uploads
npm run dev               # API on :3000
npm run worker            # in a second terminal, as many as you like
npm run web               # player on :5173
```

Set `GROQ_API_KEY` (in `.env` or the environment) to turn on transcripts, search and questions. Every setting is listed in [`docs/DEV.md`](docs/DEV.md).

## Test it

```
npm run typecheck
npm test                  # 167 fast tests, no services needed. Uses an in-memory MongoDB: it is downloaded on first run, or point MONGOMS_SYSTEM_BINARY at a local mongod
npm run test:integration  # 33 tests against real S3, Redis, Mongo and ffmpeg
```

The integration run includes the kill-a-worker test and the failure cases. See [`docs/FAILURE-DEMO.md`](docs/FAILURE-DEMO.md) for how to run each one alone.

## Numbers I measured

All on one laptop (i5-8365U, 8 threads, 8 GB) with the API, workers, Mongo, Redis and storage sharing it, so they are not server numbers. Details, setup and caveats are in [`docs/BENCH.md`](docs/BENCH.md).

| What | Result |
|---|---|
| Resume a 512 MiB upload after a cut | 36 of 64 parts were already stored and skipped, 28 re-sent, 232 MiB on the wire for the resume |
| Transcode, 4 videos of 20 s at 1080p, 16 encode jobs | 1 worker 254.2 s, 2 workers 159.7 s (1.59x), 4 workers 135.1 s (1.88x). One run per count |
| Key route, 50 viewers at once, 2 hour video | 124 to 128 requests/s with event and flag writes (3 runs, p50 366 to 382 ms), 218 to 235 without (2 runs, p50 198 to 215 ms) |
| Playback start, 50 at once | p50 425 to 461 ms with analytics (3 runs), 310 to 331 ms without (2 runs) |

Test counts above come from the last full run on 2026-10-30.

## Read more

- [`docs/SECURITY.md`](docs/SECURITY.md): what each protection stops, which test shows it, and what is not stopped.
- [`docs/TRADEOFFS.md`](docs/TRADEOFFS.md): the choices and what each one costs.
- [`docs/EVAL.md`](docs/EVAL.md): how the search and answer quality will be measured.
- [`PLAN.md`](PLAN.md): the plan the phases were built from.

## Not done or not measured

- **This is not DRM.** Screen recording works, and the watermark is a page element that can be removed. A script holding a valid token can fetch the keys of a video it may watch.
- **Search and answer quality is not measured.** Everything in phase 5 ran against a fake provider. The hit rate needs a real speech video, a Groq key and questions written before looking at answers (`docs/EVAL.md`). No quality number is claimed.
- **Not deployed.** Docker files and a CI workflow are written but have not run yet (this machine has no Docker). No live link yet. See `docs/DEPLOY.md`.
- **One API process only** was tested. Rate limits live in memory.
- **Flag thresholds are guesses** and have not seen real traffic.
- **Safari's native HLS** is not supported and not tested.
- **`/media`** serves encrypted segments from the API for development. A bucket or CDN should do that in production (`HLS_BASE_URL`, `KEY_URL_BASE`).
- The benchmarks have 1 or 2 runs each, so run-to-run spread is not known.
