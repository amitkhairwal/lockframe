# Tradeoffs

Each entry is a choice, why it was made, and what it costs. Some came from the plan, some from what the build showed.

**One encode job per rendition, not one job per video.** Jobs for 1080, 720, 480 and 360 can go to different workers. The cost is that each reads the source again. On the benchmark machine four workers were 1.88 times faster than one, not four times (`docs/BENCH.md`), because the CPU was already full.

**Segments encrypted in Node after ffmpeg, not by ffmpeg's own key file.** With ffmpeg's own encryption the key comes from a key file, and rotating it mid-encode was not something I wanted to depend on. Encrypting afterwards means no plain segment is ever uploaded, and the IV rule (segment number) is simple to test. The cost is that each segment is read into memory once.

**One key per 5 segments, shared by every rendition.** Encodes use fixed keyframe times and no scene cuts (`test/ffmpeg.test.ts`), so segment boundaries line up across renditions and one key covers the same 30 s in all of them and quality switches need no extra key request. The cost is that a key opens 30 s of every quality at once.

**Key route takes only a bearer token.** No cookie means no cross-site request can use the session. The cost is that only a player that can set a header works, so Safari's native HLS does not.

**Device lease id is made by the server.** A client-chosen device id can be copied between machines. A server-made id has to be held, so it travels with the token. The cost is that a closed tab keeps the slot for up to 90 s if the browser never sends the stop beacon.

**Playback token life 2 minutes, lease 90 seconds.** Short enough that removing access bites quickly, long enough to survive a slow refresh. Both are settings. Neither number was tuned.

**Transcription runs after "ready", on its own queue.** Playback never waits for a model call or a rate limit. The cost is that for a while a ready video has no captions or search.

**Audio pieces saved as they come back.** A rate limit on piece 7 should not make us pay for pieces 1 to 6 again. The cost is some transcript data held in Mongo until the merge.

**Search is Mongo text search plus model-made keywords, no vectors.** Groq has no embeddings endpoint and a second provider was not worth it before knowing whether text search is good enough. The cost is weaker matching on paraphrase. Not measured yet, see `docs/EVAL.md`.

**An answer needs a citation that points at a real excerpt.** Otherwise it is shown as "not found". This makes the model look less helpful and makes wrong answers easier to catch.

**MongoDB, not Postgres.** The records here are documents with arrays (renditions, chunks, events), there is no join worth having. The cost is no transactions across collections, so deletes are ordered (objects first, record last) so a half-failed delete can be retried.

**S3 API behind a small interface, SeaweedFS for tests.** The development machine has no Docker, so tests run against a local SeaweedFS binary. It found a real difference: `ListParts` does not echo the part checksum, so the signed checksums are also stored in Mongo and used when completing the upload. The cost is a second source of truth for part sums.

**Own in-memory rate limiter.** About fifteen lines, no dependency, enough for one process. The cost is that it does not share state between instances.

**Progress over Redis pub/sub and Socket.io.** Workers publish, the API forwards to the owner's room. The cost is that an event can be missed while a client is disconnected, so the page also reloads the list when something finishes.

**Flags are rules, written for the owner, with a model-made summary.** The rules are exact and testable. The model only writes two sentences from counts and times, without the viewer's address. The cost is that the rules are heuristics and the numbers are guesses.

**`/media` served by the API in development.** Convenient and encrypted anyway. Free hosting would count that bandwidth, so deployment needs a bucket or CDN (`HLS_BASE_URL`, `KEY_URL_BASE`).

**No Docker on the development machine.** Docker and the compose file are phase 8, and a CI job has to build and run them, because a compose file that has never run is only a guess.
