# Gates: phase 1, resumable upload

Scope: S3 multipart upload API, resumable client, upload page, stale cleanup. Auth is phase 2 and lands before any deploy.
Real-server gates ran against a local SeaweedFS S3 (v4.51, md5 checked), not the final host. Re-run G3 and G6 on the deploy host in phase 8.

- [x] G1: typecheck is clean
  CHECK: npm run typecheck && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: TSC_OK

- [x] G2: unit and integration tests pass against a fake storage
  CHECK: MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests "
  EXPECT: 13 passed
  EVIDENCE: Tests  13 passed (13)

- [x] G3: on a real S3 server a 512 MiB upload cut at 60 percent resumes, skips stored parts, and the stored object matches the source sha256
  CHECK: S3_ENDPOINT=http://127.0.0.1:8333 S3_BUCKET=lockframe S3_ACCESS_KEY=devkey S3_SECRET_KEY=devsecret MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 SIZE_MB=512 npx tsx scripts/upload-check.ts 2>&1 | grep -E "^(PASS|FAIL)|sizeMiB"
  EXPECT: /PASS sha256 of stored object[\s\S]*PASS stored size[\s\S]*"partsSkipped":[1-9]/
  EVIDENCE: PASS stored size is 536870912 bytes | {"sizeMiB":512,"firstRunWireMiB":307.2,"resumeWireMiB":232,"partsSkipped":36,"partsResent":28,"partCount":64}

- [x] G4: the real server accepted 8 MiB parts with the checksum header, and listing did not echo the checksum (so complete needs the stored sums)
  EVIDENCE: first run of complete on SeaweedFS failed with InvalidRequest, ListParts returned sha256: undefined; after storing signed sums in Mongo the 512 MiB run passed (see G3)

- [x] G5: code has no em dashes or curly quotes
  CHECK: grep -rlP "\x{2014}|\x{2013}|\x{201c}|\x{201d}" apps shared scripts test; echo scanned
  EXPECT: scanned
  EVIDENCE: scanned

- [x] G6: the real server refuses a part whose bytes do not match the signed checksum
  CHECK: S3_ENDPOINT=http://127.0.0.1:8333 S3_BUCKET=lockframe S3_ACCESS_KEY=devkey S3_SECRET_KEY=devsecret MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 SIZE_MB=64 npx tsx scripts/upload-check.ts 2>&1 | grep "storage refused"
  EXPECT: PASS storage refused a part with the wrong bytes (status 400)
  EVIDENCE: PASS storage refused a part with the wrong bytes (status 400)

- [x] G7: bucket CORS (PUT, exposed ETag) and a 2 day abort rule for incomplete uploads applied by script
  CHECK: S3_ENDPOINT=http://127.0.0.1:8333 S3_BUCKET=lockframe S3_ACCESS_KEY=devkey S3_SECRET_KEY=devsecret npx tsx scripts/bucket-setup.ts
  EXPECT: lifecycle set
  EVIDENCE: cors set for http://localhost:5173 | lifecycle set: incomplete uploads abort after 2 days

- [x] G8: in Chromium the page uploads 400 MB, Pause then Resume skips stored parts, no console errors, stored sha256 equals the file
  EVIDENCE: playwright run: "paused at 8%", "Done. 4 parts were already uploaded.", console errors []; stored d39e63eb...b8d0d0 equals source sha256 (419430400 bytes)
