# Failure demo

Each entry breaks something on purpose and shows what the system does. They are integration tests, so they run against real SeaweedFS, Redis, Mongo and ffmpeg. Start those first (see `docs/DEV.md` for the environment variables), then run any entry with:

```
npm run test:integration -- -t "<test name>"
```

The tests inside one group share a video made by the first test, so entries below that name a group run the whole group. Each run takes between a few seconds and a minute, mostly ffmpeg.

| Break this | Test name to pass to `-t` | What you see |
|---|---|---|
| Kill a worker with SIGKILL in the middle of an encode | `is taken over by another worker` | The lock on the job expires, another worker takes it, and the video still ends `ready` with every rendition complete. |
| Shut a worker down cleanly mid-encode | `hands a running encode back to the queue` | The running encode is put back on the queue, partial output is removed, the next worker finishes it. |
| Upload a file that is not a video, or audio only | `fails with a readable reason, drops the raw file` | Status `failed` with a plain reason, the raw object is deleted, the job is not retried. |
| Make every encode fail | `permanent failure and retry` | A few retries, then `failed`, no partial segments left, no job stuck in the queue. The failure text contains no signed URL. |
| Retry a failed video | `permanent failure and retry` (same group) | The owner's retry reaches `ready`. Anyone else is refused. |
| Delete a video while it is encoding | `stops the work, leaves no output` | The work stops, no objects remain, the worker takes the next job. |
| Play without a token, with another viewer's token, or after access is withdrawn | `rotating keys on real storage` | ffmpeg itself fails at the key request. |
| Open the video on a second device | `second device refused` | The second start is refused with 409, the first keeps playing, the slot frees when the first stops. |
| Close the tab without stopping | `lapses by itself after its TTL` | The slot frees after the lease TTL, so the user is not locked out. |
| Rate limit or bad key from the speech provider | `a failure on piece 2 keeps piece 1` | The video stays `ready`. The retry does not pay for piece 1 again. A rejected key (`a rejected key is not retried`) fails at once instead of looping. |
| Delete a video while it is being transcribed | `leaves nothing behind` | No transcript, chunks or audio pieces remain. |
| Run with no provider key | `marks videos "off" and queues nothing` | Videos play normally, search and ask answer 503. |
| Scrape keys far ahead of the playhead, replay many times, try many devices | run the file: `npm run test:integration -- integration/analytics.int.test.ts` | The owner sees `key_ahead`, `repeat_replays` and `many_devices` flags with a short summary. |

Not shown by a test and not done:

- Losing Redis or Mongo while running. Not tried, so nothing is claimed about how the API and workers behave.
- A full disk or a slow S3.
- Two API instances at once. State that matters (queue, lease) is in Redis, but the rate limiters are per process, and nothing was run with two.
