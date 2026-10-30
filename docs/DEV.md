# Local dev notes

Real-infra tests need an S3 server, Redis and ffmpeg on PATH. The fast suite (`npm test`) needs none of them.

```
export S3_ENDPOINT=http://127.0.0.1:8333 S3_BUCKET=lockframe S3_ACCESS_KEY=... S3_SECRET_KEY=...
export REDIS_URL=redis://127.0.0.1:6390
npm run test:integration
```

## Playback settings

| Variable | Default | Meaning |
|---|---|---|
| `KEY_ROTATE_SEGMENTS` | 5 | segments per AES key (6 s each, so a new key every 30 s). Read by the worker at encode time. |
| `KEY_URL_BASE` | empty | written in front of `/api/keys/...` inside playlists at encode time. Empty means same origin as the playlist (dev). Set it to the API origin when playlists come from a bucket or CDN. |
| `HLS_BASE_URL` | `/media` | where the player loads master playlists from. `/media` is served by the API itself and is for development and small demos only. |
| `PLAYBACK_TOKEN_SECONDS` | 120 | life of a playback token. The player renews it every 60 s. |
| `LEASE_SECONDS` | 90 | how long a viewer keeps the one playback slot without a heartbeat. |
| `CORS_ORIGINS` | `http://localhost:5173` | origins allowed to call the key route from the browser (also used by `bucket:setup`). |

What the protection is and is not: segments are AES-128 encrypted and keys are only handed to a signed-in owner or invited viewer holding the one active slot, so a copied playlist or segment URL is useless on its own. A viewer can still screen record, and a script holding a valid token can fetch the keys of a video it may legitimately watch. The watermark is drawn by the page, so it deters casual sharing but is not forensic.

## Transcripts, search and questions

Off unless `GROQ_API_KEY` is set. Without it videos are marked "off", nothing is queued, and search and ask answer 503. Playback is never affected.

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | empty | key for the provider. Put it in `.env`, never in a commit. |
| `AI_BASE_URL` | Groq's OpenAI compatible URL | any OpenAI compatible server works, tests point it at a local fake |
| `STT_MODEL` | `whisper-large-v3-turbo` | transcription model |
| `LLM_MODEL` | `openai/gpt-oss-120b` | chapters, keyword widening and answers |
| `AUDIO_PIECE_SECONDS` | 600 | audio is cut into pieces this long (about 2.4 MB each) to stay under the upload limit |
| `AUDIO_OVERLAP_SECONDS` | 6 | pieces overlap so a sentence on a cut is heard whole |
| `AI_JOB_ATTEMPTS` / `AI_JOB_BACKOFF_MS` | 5 / 15000 | retries for rate limits and server errors. A rejected key is not retried. |
| `ASKS_PER_MIN` | 6 | questions per user per minute (each can use two model calls) |

Finished audio pieces are saved as they come back, so a retry only pays for the missing ones. Search is Mongo text search (stemmed, no vectors). A question first asks the model for related keywords, then retrieves up to 6 chunks of 30 to 60 s, then asks for an answer that must cite excerpt numbers. An answer without a valid citation is shown as "not found". The transcript is untrusted input: it is fenced in the prompt and the reply is validated, but a model can still be wrong, so every answer links to the moment it came from. `docs/EVAL.md` shows how to measure the hit rate on a real video.

## Analytics and flags

The player reports `play`, `pause`, `seek`, `ended` and a `progress` ping every 10 s to `POST /api/videos/:id/events`. Progress only moves the saved resume position. The rest are also stored as events, which Mongo drops after `EVENT_DAYS` (30). The server adds its own events: `start` (a fresh viewing, not a refresh), `denied` (a second device was refused), `key` and `key_ahead` (a key request, the second when the key is more than `FLAG_AHEAD_SECONDS` past the last reported position).

| Rule | Fires when | Defaults |
|---|---|---|
| `many_devices` | refused second-device attempts | 3 in 10 min (`FLAG_DEVICE_DENIALS`) |
| `repeat_replays` | fresh starts of one video | 6 in 60 min (`FLAG_REPLAY_STARTS`) |
| `key_ahead` | keys asked for far past the playhead | 3 in 10 min, gap over 120 s (`FLAG_AHEAD_COUNT`, `FLAG_AHEAD_SECONDS`) |
| `key_burst` | key requests of any kind | 12 in 60 s (`FLAG_BURST_KEYS`) |

A flag goes to the video owner, one per rule and viewer, and stays dismissed once dismissed. If a provider is configured, a short summary is written from counts and times only (no email, no transcript); if that fails the flag shows its rule text. Limits: the position comes from the player, so a script that reports a fake position can avoid `key_ahead`, and the thresholds are untuned guesses until there is real traffic to measure.
