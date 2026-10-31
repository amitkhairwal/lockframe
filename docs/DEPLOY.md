# Deploying

One deployment, one live link. The API also serves the built player, so the link is the API's address. Every host claim below is marked as checked or not.

The chosen setup: Render (one free web service running API and worker together), MongoDB Atlas M0, Redis Cloud free (30 MB), Backblaze B2. Card-free hosts that give a separate always-on worker were not found (checked 2026-10-31: Render free has no background workers, Hugging Face Docker Spaces now need a paid plan).

## What runs where

| Part | Needs | Notes |
|---|---|---|
| API and player | Node 22, the `Dockerfile` | `npm start`. Serves `/api`, `/media`, `/socket.io` and the player. Needs ffmpeg only if it also runs jobs, which it does not. |
| Worker | the same image, `npm run worker`, ffmpeg | CPU heavy. On a host with one free web service, run both with `bash scripts/start-all.sh`: if either process exits, the other is stopped too so the host restarts the container. Measured locally against Atlas, Redis Cloud and B2: about 265 MB idle for both, 405 MB peak while encoding the 6 s smoke clip. A worker on your own machine against the same hosted services also works. |
| MongoDB | any 6+ server | Atlas M0 (512 MB) is enough for a few videos. Not checked: whether it needs a card. |
| Redis | any 7 server, no per-command billing | BullMQ polls, so a host that bills per command can burn its quota fast. The device lease lives here too. |
| S3 storage | S3 API with CORS, presigned PUT, multipart, and per-part SHA-256 | Backblaze B2 checked: `upload-check` passes 8 of 8 (wrong bytes refused, resume after a cut, sha256 match, delete leaves nothing) and `smoke` passes. Use an application key scoped to the bucket with read and write; it cannot create buckets, so create the bucket in the B2 console first. Cloudflare R2 may ask for a payment method (not checked). |

## Settings for production

| Variable | Set it to |
|---|---|
| `NODE_ENV` | `production`. Turns on Secure cookies and refuses to start without a real `JWT_SECRET`. The site must be https. |
| `JWT_SECRET` | 32 or more random characters (`openssl rand -hex 32`). Sessions and playback tokens are signed with it. |
| `MONGODB_URI` | the Atlas connection string |
| `REDIS_URL` | the hosted Redis URL |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | the storage host |
| `S3_PUBLIC_ENDPOINT` | the address a browser can reach, if different from `S3_ENDPOINT` |
| `CORS_ORIGINS` | the site's own origin, for example `https://your-app.example`. Also used by `npm run bucket:setup` for the bucket's CORS rule. |
| `TRUST_PROXY` | number of proxy hops in front of the API (1 on most hosts). With 0 the API ignores `X-Forwarded-For` and every visitor shares one rate limit. |
| `HLS_BASE_URL`, `KEY_URL_BASE` | leave unset for a small demo: segments then go through the API's `/media` route, which uses the API host's bandwidth. For real traffic, serve `hls/` from a public bucket or CDN, set `HLS_BASE_URL` to it, and set `KEY_URL_BASE` to the API's origin. `KEY_URL_BASE` is baked into playlists when a video is encoded, so set it before uploading. |
| `GROQ_API_KEY` | optional. Turns on transcripts, search and questions. |
| `MAX_DURATION_SECONDS`, `MAX_UPLOAD_BYTES` | cap the demo (clip length and size) so a free host is not overwhelmed |
| `MAX_HEIGHT`, `FFMPEG_THREADS` | tallest rung of the ladder (default 1080) and ffmpeg threads. On a 512 MB instance use 480 and 1. |

Worker machine: the same `MONGODB_URI`, `REDIS_URL`, `S3_*`, `KEY_ROTATE_SEGMENTS` and `KEY_URL_BASE` as the API, plus ffmpeg.

## Steps

1. Create the Mongo database, the Redis instance and the bucket. Put the values in the host's secret settings, never in the repo.
2. Run `npm run bucket:setup` once with the production `S3_*` and `CORS_ORIGINS` set (it creates the bucket if the host allows that, sets CORS, and aborts unfinished uploads after 2 days).
3. Deploy the `Dockerfile` as a web service on port 3000 with the variables above. Health check path: `/healthz` (touches no database).
4. Start a worker with the same variables.
5. `BASE=https://your-app.example npx tsx scripts/smoke.ts`. It signs up two users, uploads a 6 s clip, waits for `ready`, fetches a key with and without a token, and checks a stranger is refused. Needs ffmpeg on the machine running it.
6. Upload a demo video you own or one that is public domain, and check playback in a browser.

## Known catches

- A free web service that sleeps on idle makes the first request slow. State cold start separately from any latency number.
- The in-memory rate limiter is per process, so run one API instance.
- Locally, `docker compose up` starts the whole stack (`docker-compose.yml`). It has not been run on this machine, which has no Docker; CI builds and runs it and then runs the smoke script.
