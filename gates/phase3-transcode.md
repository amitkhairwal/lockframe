# Gates: phase 3, queue and transcode

Scope: after an upload completes, workers probe the file, encode an aligned HLS ladder, publish a master playlist, and mark the video ready. Progress is live over Socket.io. Encryption and playback are phase 4, so output here is plain HLS and no playback route exists yet.
Real-infra gates run against local SeaweedFS S3, Redis 7.4.1 (built from source, hash checked), Mongo 8.2 and system ffmpeg 4.4.

- [x] G1: typecheck clean
  CHECK: npm run typecheck && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: > tsc --noEmit && tsc --noEmit -p apps/web | TSC_OK

- [x] G2: fast tests pass with no infra (ladder, ffprobe parsing, ffmpeg args, master playlist, progress parsing, auth, access, uploads)
  CHECK: MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  67 passed (67)

- [x] G3: ladder is capped at the source height and never empty
  EVIDENCE: test/media.test.ts: ladders for 2160/1200/1080/720/480/360 heights, 241 gives one rung at 240 (a first draft gave 242, an upscale; fixed and re-tested), never empty, bitrates fall down the ladder

- [x] G4: real ffmpeg output of every rendition has keyframes at every segment start, and segment boundaries line up across renditions (checked with ffprobe)
  EVIDENCE: test/ffmpeg.test.ts on a real 14 s 720p clip, rungs 720/480/360 via real ffmpeg: EXTINF 6,6,2 on every rung and identical across rungs, first packet of all 9 segments is a keyframe (ffprobe), keyframes 2 s apart, frame height equals rung height

- [x] G5: end to end on real S3, Redis, Mongo: upload, probe, encode, finalize, status ready; master lists every rendition; the downloaded HLS decodes fully with ffmpeg and its duration matches the source
  EVIDENCE: integration/pipeline.int.test.ts happy path on SeaweedFS + Redis + Mongo: ready, progress 100, renditions [720,480,360] with 3 segments each, timings for probe/encode_*/finalize, master lists all rungs, downloaded HLS decodes with ffmpeg, duration between 13.5 and 14.8 for a 14 s source, S3 holds exactly index.m3u8 + 3 segments per rung

- [x] G6: an upload that is not a video ends as failed with a readable reason, its raw file is deleted, and it is not retried
  EVIDENCE: pipeline.int.test.ts: text file named .mp4 and an audio-only mp4 both end failed with "could not be read as a video" / "no video stream", retryable false, raw and hls prefixes empty, probe job attemptsMade 1, retry returns 409

- [x] G7: a permanent encode failure (broken ffmpeg) is retried then ends failed, partial output is deleted, no job hangs in waiting-children
  EVIDENCE: lifecycle.int.test.ts with config.media.ffmpeg=/bin/false: after 2 attempts the video is failed "encoding Np failed: ffmpeg exited 1", every failed job has attemptsMade equal to the attempt limit, hls prefix empty, waiting-children 0, no temp dirs, failure text has no signature or key id

- [x] G8: kill -9 of the worker process group mid-encode, a second worker finishes the video; output is complete and has no duplicate or missing segments
  EVIDENCE: integration/kill.int.test.ts: real worker process group SIGKILLed while a rung was between 10 and 99 percent, leftover temp dir confirmed (no cleanup ran), second worker took over (completed encode job for that rung has stalledCounter >= 1), final video ready with 4 rungs x 7 segments numbered seg_00000..00006 with no gap, ffmpeg decodes it, duration 39.5 to 41 for a 40 s source

- [x] G9: a retryable failed video can be retried by its owner and then reaches ready; a stranger cannot retry it
  EVIDENCE: lifecycle.int.test.ts: stranger gets 404, owner retry returns status uploaded, run becomes 2, video reaches ready with failure unset; retry on a ready video gives 409

- [x] G10: Socket.io: handshake needs a session, a user only receives their own videos, progress is non-decreasing and the last event is ready
  EVIDENCE: lifecycle.int.test.ts: connect without a cookie or with a garbage cookie fails with "login required"; owner receives events for the one video, progress never decreases, first events are processing and the last is ready 100; a second logged in user receives none; payload contains no owner field

- [x] G11: no temp directories are left behind after success, failure, and graceful shutdown mid-encode
  EVIDENCE: tempLeft() empty after: happy path, failed run, delete-while-processing, graceful shutdown mid-encode (pipeline and lifecycle integration tests). Startup creates TMP_DIR if missing (found by the kill test: a missing dir failed the job) and sweeps sv- dirs older than 1 hour. A hard kill does leave a dir until the next worker start sweeps it, that is expected

- [x] G12: deleting a video removes its hls prefix too, and deleting while it is processing stops work without crashing the worker
  EVIDENCE: lifecycle.int.test.ts: deleting while encoding returns 204, in-flight encode aborts, video record gone, hls and raw prefixes empty, no temp dirs, and the next upload on the same worker reaches ready. Plain delete also removes hls/ (videos.remove)

- [x] G13: benchmark with 1, 2 and 4 workers recorded in docs/BENCH.md with machine, clip, threads, and raw timings
  EVIDENCE: docs/BENCH.md: i5-8365U 4C/8T 8 GB, 20 s 1080p clip, 4 videos x 4 rungs, -threads 2: 254.2 s with 1 worker, 159.7 s with 2 (1.59x), 135.1 s with 4 (1.88x); single run each, caveats written

- [x] G14: in Chromium: a processing video shows live progress, becomes ready without a reload, a failed one shows its reason and a Retry button; no console errors
  EVIDENCE: playwright run, 10 PASS: non-video shows "this file could not be read as a video" with no Retry; broken encoder shows "encoding 1080p failed" with Retry; after fixing the worker and clicking Retry the UI showed processing 3%..17%.. increasing, reached ready without navigation, row lists 1080p 720p 480p 360p, console errors []. Screenshots viewed

- [x] G15: code has no em dashes or curly quotes
  CHECK: grep -rlP "\x{2014}|\x{2013}|\x{201c}|\x{201d}" apps shared scripts test integration docs; echo scanned
  EXPECT: scanned
  EVIDENCE: scanned
