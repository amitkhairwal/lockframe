# Gates: phase 8, ship

Scope: one container image that runs the API and the built player, a compose file with a worker, a CI job that builds it and runs a smoke test against the compose stack (Docker is not on this machine, so CI is the honest check), deploy instructions, one live link.
Not mine to do: creating accounts and secrets on hosts, and pushing to GitHub. Those gates stay open until the user does them. No card on any host. One deployment, one live link.

- [x] G1: the API serves the built player and falls back to index.html for page routes, without shadowing /api, /media or /socket.io
  EVIDENCE: test/web.test.ts, 5 tests pass: index.html at /, /library and /watch/abc?x=1; assets served with a javascript type and immutable cache; /api/nope, /media/nope and /media/x/master.m3u8 stay 404 without the page; three traversal attempts (..%2F, %2e%2e, nested) did not return the secret file; POST to a page route is 404. Real run: smoke check "player page is served" passed against the built dist

- [x] G2: Dockerfile and docker-compose.yml written (api, worker, mongo, redis, s3 server, bucket setup), no secrets in them, healthcheck on the API
  EVIDENCE: Dockerfile (node 22 slim, ffmpeg, npm ci, build, healthcheck on /healthz), docker-compose.yml (mongo, redis, seaweedfs, setup, api, worker), .dockerignore, deploy/s3.json with throwaway dev keys labeled as such. YAML parses. NOT run: no Docker on this machine, CI is the check (G7). bucket-setup now creates the bucket if missing

- [x] G3: scripts/smoke.ts: against a running stack, sign up, upload a small clip, wait for ready, fetch the playlist and a key with a token, check a stranger is refused. Passes against the local stack here
  EVIDENCE: scripts/smoke.ts against the stack started here without Docker (real mongod, Redis 7.4.1, SeaweedFS, built player served by npm start, worker): 14 PASS lines ending "smoke test passed": player page, api 404, two signups, upload, ready, playback, master playlist, key without token refused, key with token 16 bytes, segment not MPEG-TS, stranger gets 404 twice

- [x] G4: .github/workflows/ci.yml: typecheck and tests, then docker compose build and up and the smoke script. YAML parses, steps reference files that exist
  EVIDENCE: .github/workflows/ci.yml: job test (typecheck, npm test) and job stack (docker compose build, up, wait on /healthz, smoke script, logs on failure, down). YAML parses with python yaml; Dockerfile, .dockerignore, deploy/s3.json and scripts/smoke.ts exist. Not run on GitHub yet

- [x] G5: docs/DEPLOY.md: every setting for production (HLS_BASE_URL, KEY_URL_BASE, CORS_ORIGINS, TRUST_PROXY, JWT_SECRET, Secure cookie), host options with their stated free-tier catches, a checklist the user can follow
  EVIDENCE: docs/DEPLOY.md: parts table, 12 production settings (names checked against config.ts for MAX_UPLOAD_BYTES and KEY_ROTATE_SEGMENTS), 6 steps, catches. Host free-tier claims marked "not checked" where I did not verify them

- [x] G6: typecheck and fast suite still pass after the changes
  CHECK: npm run typecheck && MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: typecheck 0 errors; fast suite 167 passed (162 + 5 new); integration 33 passed on 2026-10-30 after the changes; all processes stopped by pid

- [ ] G7: the CI run is green on GitHub (needs the user to push)
  EVIDENCE: pending

- [ ] G8: deployed, one live link, smoke script passes against it (needs the user's host accounts)
  EVIDENCE: pending
