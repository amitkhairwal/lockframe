# Gates: phase 4, secure playback

Scope: encrypted rotating-key HLS, playback tokens, key route, one-device lease, watermark, player page.
Honest limit stays: gated AES-128 is not DRM. A viewer can still collect keys while watching, and anyone can screen record.
Real-infra gates use local SeaweedFS S3, Redis 7.4.1, Mongo 8.2, ffmpeg 4.4.

- [x] G1: typecheck clean
  CHECK: npm run typecheck && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: > tsc --noEmit && tsc --noEmit -p apps/web | TSC_OK

- [x] G2: fast suite passes
  CHECK: MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  90 passed (90)

- [x] G3: real ffmpeg decodes our encrypted, rotated HLS when keys are served, and fails when the key server refuses or serves a wrong key
  EVIDENCE: test/hls-crypto.test.ts, real ffmpeg 4.4 + local key server: all 350 frames decode with the right keys and only /key/0../key/2 are fetched; fails when the key server refuses (403), without the token, and a wrong key does not give 350 frames; ffprobe cannot read an encrypted segment (Invalid data). test/crypto.test.ts (8): round trip, padding, wrong key/IV, big-endian IV, key tag before every 5th segment for 1/10/12/601 segments, refuses a playlist not starting at sequence 0

- [x] G4: in the bucket the playlists carry one EXT-X-KEY per rotation group, segments are not readable video without the key, and no key bytes exist anywhere in the bucket
  EVIDENCE: integration/pipeline.int.test.ts "stores only encrypted output" on SeaweedFS: every rung playlist has its EXT-X-KEY tag pointing at /api/keys/<id>/0, segments start with a byte other than 0x47, length multiple of 16, ffprobe rejects each, no object name contains key, key bytes absent from segments; keys exist only in the Mongo keys collection. playback.int.test.ts: 3 groups give 3 distinct keys and tags 0,1,2 in the 360 playlist

- [x] G5: key route refuses: no token, cookie only, garbage token, expired token, token for another video, user whose access was removed, a second device; and serves 16 bytes to the right viewer
  EVIDENCE: test/playback.test.ts (key route, in-memory Mongo): no token 401, cookie only 401, garbage 401, session cookie as token 401 (audience differs), expired 401, token for another video 403, viewer removed while token alive 403, missing key 404, bad number 400, valid 200 with 16 bytes and cache-control no-store; second device 409 on /playback and key route 403 after the slot changed hands

- [x] G6: device lease on real Redis: first device gets it, same device refreshes, other device is refused, lease lapses after its TTL, release frees it, heartbeat from a non-holder is refused
  EVIDENCE: integration/playback.int.test.ts on Redis 7.4.1: second start 409, first refreshes with its lease id and keeps it, guessed id 409, stop frees; direct redisLease: other holder refused, non-holder hold false and release no-op, slot lapses after its 1 s TTL (waited 1.3 s) and a new id is issued; with LEASE_SECONDS=2, key requests at 1 s intervals keep it alive for 3 s, then 2.5 s idle gives key 403

- [x] G7: end to end on real infra: ffmpeg given only a playback token decodes the whole video through the API (/media playlists and segments, key route for keys); key requests match the rotation count
  EVIDENCE: integration/playback.int.test.ts + pipeline + kill: decodeCheck asks /api/videos/:id/playback, then ffmpeg with only the Bearer token reads /media/<id>/master.m3u8 and /api/keys; duration 13.5..14.8 for a 14 s clip, key groups opened exactly [0,1,2] with 1 segment per key, and [0,1] for the 40 s kill-test clip (7 segments, 5 per key); both owner and invited viewer play; no token, a stranger and a removed viewer do not

- [x] G8: playback token lives 2 minutes, refreshing needs the login session, a token cannot be used for another video
  EVIDENCE: playback.test.ts: expiresIn 120, jwt audience "playback" so a login cookie is refused as a token, expired token 401, wrong video 403; /playback needs the session (no cookie 401), stranger 404, not ready 409. Token lives in PLAYBACK_TOKEN_SECONDS, renewed by the player every 60 s

- [x] G9: the phase 3 integration tests (13) still pass with encryption on
  EVIDENCE: npm run test:integration: pipeline 5, lifecycle 8, kill 1, playback 7, 21 of 21 pass (previously 13). One real race found and fixed on the way: a late fire-and-forget progress write could publish "processing 99" after "ready"; progress writes are now chained and awaited before a rung finishes, lifecycle Socket.io test run 3 more times, 3 passes

- [x] G10: keys are deleted with the video and when processing fails
  EVIDENCE: lifecycle.int.test.ts: keyCol count for the video is 0 after a permanent failure and after delete while encoding (worker also removes a key created after the delete); playback.int.test.ts delete test: keys 0 and hls prefix empty

- [x] G11: in a real browser: the player plays (currentTime advances), the watermark shows the viewer email and moves, a second browser profile of the same user is refused while the first keeps playing, no console errors
  EVIDENCE: playwright with Chromium, 12 PASS: video plays (currentTime 2.1), key requests carry a bearer token and playlists and segments do not, watermark shows watcher@example.com and moved within 8 s, key group 1 fetched after seeking past 30 s, seek works, second profile of the same user gets "playing on another device" with no video element while the first keeps playing, after Close the second plays, console errors []. Screenshots play-1.png and play-refused.png viewed

- [x] G12: code has no em dashes or curly quotes
  CHECK: grep -rlP "\x{2014}|\x{2013}|\x{201c}|\x{201d}" apps shared scripts test integration docs; echo scanned
  EXPECT: scanned
  EVIDENCE: scanned
