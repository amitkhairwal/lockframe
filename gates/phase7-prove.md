# Gates: phase 7, prove it

Scope: architecture diagram, key-route benchmark next to the transcode one, tradeoff and security notes, failure demo guide, README.
Rule for every document here: a number appears only if a command in this repo produced it, and the source is named next to it. Anything not measured says "not measured". No resume bullets until the numbers exist.
Not mine to do: the short screen recording (the user records it) and G12 of phase 5 (needs a key and a real speech video), so the README says the Q&A hit rate is not measured yet.

- [x] G1: typecheck and fast suite still pass
  CHECK: npm run typecheck && MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: > tsc --noEmit && tsc --noEmit -p apps/web | Tests  162 passed (162)

- [x] G2: key route and playback start benchmark: script committed, run on real Redis, results with machine, concurrency, request counts and raw p50 p95 p99 in docs/BENCH.md
  EVIDENCE: scripts/bench-keys.ts, real Redis 7.4.1 with in-memory Mongo on the i5-8365U laptop: 3 runs with analytics (124 to 128 req/s, key p50 366 to 382 ms), 2 runs without (218 to 235 req/s, p50 198 to 215 ms), 0 failed requests in 2000 key requests per run, raw rows in docs/BENCH.md. The key limit became a setting (KEYS_PER_MIN) so the script can lift it

- [x] G3: architecture diagram as a standalone HTML file that shows the real components and flows (upload, queue, workers, storage, key route with lease, realtime, understanding, flags), opened and looked at, text readable
  EVIDENCE: docs/diagram/architecture.html delivered with archify: validate 9 of 9 checks, 0 errors, 0 warnings; Chromium visual-check pass for containment, readability and viewer chrome at 1440x900 and 2048x1320, light and dark; 1440x900 light screenshot viewed, labels and arrows readable. Screenshots and receipt removed from the repo afterwards

- [x] G4: docs/SECURITY.md: each protection says what it stops, which test proves it, and a separate list of what it does not stop
  EVIDENCE: docs/SECURITY.md: 18 protections each with a test or script name. Names checked against the test files with grep and corrected where I had them wrong (hls-crypto, auth, rate limit and upload checksum rows). Rows with no test of their own say so. Non-protections listed. Dependency audit stated: 0 in production dependencies, 3 dev only in vitest

- [x] G5: docs/FAILURE-DEMO.md: each failure has the exact command, what you will see, and the test it comes from. Every command was run or the entry says it was not
  EVIDENCE: docs/FAILURE-DEMO.md: every -t command run on 2026-10-30 against real SeaweedFS, Redis, Mongo, ffmpeg. 11 passed alone; "does not leak the presigned url", "lets the owner retry..." and "ffmpeg cannot play it without a token" failed alone because they reuse a video made by the first test of their group, so the doc names the group: "permanent failure and retry" 4 passed, "rotating keys on real storage" 3 passed. Analytics file: 4 passed. Untried cases listed in the doc

- [x] G6: docs/TRADEOFFS.md: the real decisions with the reason and the cost, taken from PLAN.md and from what building showed
  EVIDENCE: docs/TRADEOFFS.md: 16 entries. Claims I could not source (an Atlas limit, ffmpeg key file behavior, MinIO availability, a concurrency of 4) were removed or reworded; the 1.88x figure matches docs/BENCH.md

- [x] G7: README: what it is, how to run it, how to test it, architecture link, measured numbers with sources, honest limits, what is not done. Every number in it traced to a source
  EVIDENCE: README.md: numbers from docs/BENCH.md and the phase 1 run (36 of 64 parts skipped, 232 MiB on the wire), test counts 162 and 33 from the 2026-10-30 runs; Q&A quality marked not measured; limits section

- [x] G8: the commands the README gives were run as written (install, typecheck, test, dev stack start)
  EVIDENCE: run as written on 2026-10-30: npm install, npm run typecheck (0 errors), npm run bucket:setup ("cors set", "lifecycle set"), npm run dev (/healthz 200), npm run worker ("ready"), npm run web (200 on localhost:5173), npm test (162 passed). All stopped by pid

- [x] G9: writing check: no em dashes, curly quotes, or stock AI vocabulary in README and docs
  CHECK: (grep -rniP "leverage|robust|seamless|delve|comprehensive|cutting-edge|state-of-the-art|streamline|empower|game-chang|\x{2014}|\x{2013}|\x{201c}|\x{201d}|\x{2019}" README.md docs --include=*.md scripts/bench-keys.ts || true); echo scanned
  EXPECT: /^scanned$/
  EVIDENCE: scanned
