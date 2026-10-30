# Gates: phase 6, analytics and flags

Scope: resume position, playback events, owner analytics, rule-based flags (many devices, repeated replays, keys requested far ahead of the playhead, key bursts), LLM-written summary per flag.
Honest limit stays in the README: the playhead position is reported by the player, so a script that lies about it can dodge the "far ahead" rule. Rules are heuristics that raise a question for the owner, they do not prove anything.
Flags go to the video owner (the viewer is the one being looked at). The plan said /api/admin/flags, there is no admin role in this product.
Everything here runs on in-memory Mongo with the fake provider, plus real infra in G9 and the browser in G10.

- [x] G1: typecheck clean
  CHECK: npm run typecheck && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: > tsc --noEmit && tsc --noEmit -p apps/web | TSC_OK

- [x] G2: fast suite passes
  CHECK: MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  162 passed (162)

- [x] G3: pure rule evaluation: each rule fires at its threshold and not one below, windows are respected, events of other viewers and old events are ignored, evidence carries the counts
  EVIDENCE: test/rules.test.ts (9): many_devices, repeat_replays and key_ahead each fire at the threshold and not at threshold minus 1; events just outside the window and from the future are ignored; key_burst counts key and key_ahead together and does not fire when the same count is spread over 10 minutes; two rules at once report their windows; an ordinary session gives []; groupStart(1,5,6)=30

- [x] G4: resume: position saved by owner and viewer only, clamped to the video length, a finished video restarts from 0, a stranger gets 404, bad input 400, resume value comes back with the playback token
  EVIDENCE: test/analytics.test.ts resume: owner 42.7 gives resume 42, viewer 300 gives 300 (separate); 5000 is clamped to 600 and resumes at 0 (within 10 s of the end); position 3 resumes 0; 595 resumes 0; ended gives completed true, position 0; stranger 404, unknown type 400, client-sent start and denied 400, -1 / "x" / null / {} / missing position 400, no login 401, processing video 409; resume comes back inside the /playback response

- [x] G5: events: whitelist of types, position validated, progress pings do not fill the events collection, rate limited, events expire (TTL index exists)
  EVIDENCE: test/analytics.test.ts events: 5 progress pings stored 0 events; play, pause, seek, ended stored in order; 121 progress calls in a minute end with 429; events collection has an index on at with expireAfterSeconds 30 days

- [x] G6: server-side events come from the real routes: a fresh start, a refused second device, each key request, and a key requested far ahead of the last reported position
  EVIDENCE: test/analytics.test.ts server side events: one start for a start plus two refreshes, one denied for a refused second device; keys 0 and 1 stored as key (gap 0 and 30), group 9 stored as key_ahead with gap 270; after a client-reported seek to 270 the same key is a plain key. integration/analytics.int.test.ts: ffmpeg playback on real infra recorded 1 start and at least 3 key events

- [x] G7: flags: raised at the threshold for the right viewer, de-duplicated per rule, visible to the owner only, dismiss works and a dismissed flag stays dismissed, an ordinary viewing session raises nothing
  EVIDENCE: test/analytics.test.ts flags: 2 denials give no flag, the 3rd gives many_devices for viewer@example.com with title Course and count 3, owner sees it, the viewer and a stranger see [], 5 denials still one flag with count 5, viewer and stranger get 404 on dismiss, owner gets 204 and the list is empty and stays empty after more denials; repeat_replays after 6 starts; key_ahead for a client that never reports position and takes keys 5, 6, 7; key_burst after 12 key calls; an ordinary session (play, 4 keys with progress, pause, seek, key after seek, ended) raises nothing

- [x] G8: summary: written by the model from structured facts only (no viewer email, no transcript), validated, missing when the model fails or no key, the flag still shows its rule text
  EVIDENCE: test/analytics.test.ts summary: the model gets a system prompt saying use only the facts, and JSON with rule, meaning, timesSeen 3, withinMinutes 10, videoLengthMinutes 10, and neither the viewer email nor the user id; replies 500, junk text, empty string and a number leave summary undefined while the flag shows its rule text; after a failure no second call inside the 10 minute cooldown, a retry after the cooldown writes the summary; with no provider the flag has no summary

- [x] G9: real Redis and S3 end to end: a real player-like client replays, switches device and scrapes keys ahead of its playhead, the owner sees the flags
  EVIDENCE: integration/analytics.int.test.ts on SeaweedFS, Redis, Mongo, ffmpeg: ffmpeg playing the whole video as owner raises 0 flags; resume 9.4 gives 9 after the real trip; bob replays 3 times, tries a second device twice (409), and takes keys 0,1,2 with position reported at 0, and the owner sees repeat_replays, many_devices and key_ahead for bob@example.com, each with the summary; bob sees none; the summary prompts contain no address; owner overview has at least 5 starts and 1 watcher; delete clears events, watch and flags. First run failed because the saved position was 9.4 so keys were not ahead: the test was wrong, the rule was right

- [x] G10: in Chromium: resume continues from the saved position after a reload, owner sees Stats and the Flags tab with summary and Dismiss, console clean
  EVIDENCE: playwright Chromium, 7 PASS: played to 23.4 and paused, after a reload playback continued at 23.0 not 0, stats "2 starts, 1 people watched, 0 finished", three refused attempts from a second profile gave a Flags tab entry "Tried to play on a second device several times" seen 3 times, the summary text, Dismiss emptied the list, console errors []. Screenshot an-flags.png viewed

- [x] G11: delete removes watch positions, events and flags of the video
  EVIDENCE: test/analytics.test.ts delete removes events, watch and flags of the video (DELETE 204, counts 0); integration test checks the same on real infra

- [x] G12: code has no em dashes or curly quotes
  CHECK: grep -rlP "\x{2014}|\x{2013}|\x{201c}|\x{201d}" apps shared scripts test integration docs; echo scanned
  EXPECT: scanned
  EVIDENCE: scanned
