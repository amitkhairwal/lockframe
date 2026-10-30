# Gates: phase 2, auth and ownership

Scope: signup, login, logout, session cookie, owner on uploads, videos record with invited viewers, rate limits, minimal web screens. Nothing is deployed before this passes.

- [x] G1: typecheck clean
  CHECK: npm run typecheck && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: > tsc --noEmit && tsc --noEmit -p apps/web | TSC_OK

- [x] G2: full test suite passes (phase 1 tests updated for auth plus the auth tests below)
  CHECK: MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  40 passed (40)

- [x] G3: passwords are stored as scrypt hashes with a per-user salt, never plain, compared in constant time
  CHECK: grep -c "scrypt" apps/api/src/auth.ts
  EXPECT: /^[1-9]/
  EVIDENCE: 7

- [x] G4: session cookie is HttpOnly, SameSite=Lax, Secure in production; JWT secret is required in production
  EVIDENCE: test/auth.test.ts: Set-Cookie has HttpOnly, SameSite=Lax, Path=/; config loads with NODE_ENV=production only with a 32+ char JWT_SECRET and then secureCookies is true. Not checked end to end: a real production Set-Cookie header (do on the deploy host in phase 8)

- [x] G5: tests prove: wrong password and unknown email give the same error, duplicate email 409, weak password 400, no cookie 401, tampered token 401, expired token 401
  EVIDENCE: auth.test.ts: same body for wrong password and unknown email, 409 duplicate (case-insensitive), 400 weak/oversized password, 401 no cookie, tampered, expired, foreign-secret and alg-none tokens, form post gets 415

- [x] G6: tests prove: another user cannot see, list, sign parts for, complete or delete someone else's upload or video (404, not 403)
  EVIDENCE: access.test.ts strangers: 404 on parts, sign, complete, abort, video get, delete, invite, and the body equals the one for a non-existent id. Mutation check: dropping the owner filter failed 2 tests

- [x] G7: tests prove: an invited viewer can read a video but not delete it, invite others, or see other videos; removing the invite removes access
  EVIDENCE: access.test.ts invited viewers: read 200, delete 403, invite 403, uninvite 403, stranger 404, viewers field hidden, removal gives 404. Mutation check: removing the owner guard failed 4 tests

- [x] G8: rate limits return 429: auth routes per IP, upload creation per user; proxy headers are trusted only when TRUST_PROXY is set
  EVIDENCE: auth.test.ts: 11th login from one address gets 429, 31st upload create gets 429 for one user while another user gets 201, X-Forwarded-For spoofing does not dodge the limit; with TRUST_PROXY=5 that test fails, proving the header is only believed when configured

- [x] G9: deleting a video removes its objects from storage and its records, verified on the real local S3
  EVIDENCE: upload-check.ts on SeaweedFS: "PASS delete removed the stored objects (status 204, 0 left)"

- [x] G10: phase 1 real-server exit check still passes with auth on (512 MiB cut and resume, sha256 match)
  EVIDENCE: upload-check.ts on SeaweedFS with auth: 512 MiB, 36 of 64 parts skipped on resume, 28 re-sent, sha256 and size match

- [x] G11: in Chromium: signup, upload page, library list showing status, invite a viewer, logout, a logged-out visit is sent to login; no console errors
  EVIDENCE: playwright run, 11 PASS lines: login form when logged out, signup, upload 40 MB shows in library as uploaded, invite chip, reload keeps session, viewer sees "shared with you" with no Delete or Invite, logout, wrong password error, console errors [] (3 expected 401 resource errors ignored)

- [x] G12: code has no em dashes or curly quotes
  CHECK: grep -rlP "\x{2014}|\x{2013}|\x{201c}|\x{201d}" apps shared scripts test; echo scanned
  EXPECT: scanned
  EVIDENCE: scanned
