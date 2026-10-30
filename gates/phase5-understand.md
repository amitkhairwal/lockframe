# Gates: phase 5, understand

Scope: audio extraction, transcription with timestamps, WebVTT, 30 to 60 s chunks, chapters, text search, Q&A with timestamp citations and a "not found" answer.
Provider: Groq (OpenAI compatible API), behind an interface. Everything except G12 runs against a fake provider server that speaks the same HTTP shape, so no key is needed for G1 to G11.
G12 needs a real key and a real speech video from the user. Until both exist it stays open, and any hit rate is reported only as measured on that run.
Search is Mongo text search plus an LLM keyword expansion. Vector search is not built: Groq has no embeddings endpoint and a second provider is not worth it until the measured hit rate says text search is weak.

- [x] G1: typecheck clean
  CHECK: npm run typecheck && echo TSC_OK
  EXPECT: TSC_OK
  EVIDENCE: > tsc --noEmit && tsc --noEmit -p apps/web | TSC_OK

- [x] G2: fast suite passes
  CHECK: MONGOMS_SYSTEM_BINARY=$HOME/workspace/scrawl/node_modules/.cache/mongodb-memory-server/mongod-x64-zorin-8.2.6 MONGOMS_VERSION=8.2.6 npx vitest run 2>&1 | grep -E "Tests |FAIL"
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: Tests  131 passed (131)

- [x] G3: pure helpers: overlapping audio pieces merge without duplicate or lost sentences, chunks are 30 to 60 s at segment boundaries, VTT is valid, chapter output from the model is validated and bad output is dropped
  EVIDENCE: test/transcript.test.ts (17): overlap merge keeps all 40 sentences once with right times (two pieces of 100 s, 10 s overlap), offsets added and empty text dropped; chunks 25 to 60 s at segment edges with no text lost, long single segment stays whole, tiny tail joins previous; VTT escapes < & --> and never writes a zero length cue; chapters: bad start, non-string title, past the end, closer than 20 s, 200 char title and html tags are cleaned; audioPieces for 90 s, 600 s, 1500 s (3 overlapping pieces covering exactly 1500) and 605 s

- [x] G4: provider client against a fake Groq server: bearer header, multipart fields, verbose_json parsing, 429 with retry-after becomes a retryable error, 401 is not retried, the key never appears in an error message
  EVIDENCE: test/ai.test.ts (6) against test/fakeAi.ts, an HTTP server with Groq shape: Authorization Bearer, model, response_format verbose_json, temperature 0, mp3 bytes counted; 429 with retry-after 7 gives retryable and 7000 ms; 401, 400, 413 not retryable, 500 and 503 retryable; the fake echoes the bearer value in its error and the client message shows [key] instead; unreachable host is retryable

- [x] G5: real S3, Redis, ffmpeg, Mongo: after ready, the understand job runs, stores segments, chunks, chapters, VTT, sets understanding done; playback was already allowed before it finished
  EVIDENCE: integration/understand.int.test.ts on SeaweedFS, Redis, Mongo, ffmpeg with the fake provider: right after ready the state is pending or running and POST /playback returns 200 while /ask returns 409; later done; provider got 2 mp3 uploads (5 kB to 200 kB each, 10 s pieces); stored segments are exactly the 3 expected sentences once each at 0, 4, 9 s, pieces removed, 1 chunk, chapter list stored; /understanding, captions.vtt (00:00:09.000 --> 00:00:13.000), search (start 9) and ask with citation start 4 work through the API

- [x] G6: a failure on audio piece 2 and a retry does not call the provider again for piece 1, and the video never leaves ready
  EVIDENCE: same file: piece 1 always 500, piece 0 call count is 1 across 3 attempts, failure text "provider said 500", video status stays ready, only piece 0 kept; after POST understanding/retry (200, uRun 1) exactly one provider call is made and the transcript completes with the same 3 sentences; a 401 is tried once and not retried, message has no key

- [x] G7: search: owner and viewer only, a stranger gets 404, ranking by relevance, results carry start time and snippet, empty query refused
  EVIDENCE: test/understand.test.ts search: finds the sentence (start 54, 0:54, not the chunk start), ranks closure sentences first, library-wide search returns only videos the caller owns or was invited to (stranger private video never shows for owner or viewer), 404 for someone else video, 400 for 1 char or missing query, 401 without login, [] for no match, the model is never called

- [x] G8: Q&A: grounded answer with citations that point at real chunks, "not found" without calling the model when nothing matches, an invented citation is dropped, a transcript that contains instructions does not change the output shape, per-user rate limit
  EVIDENCE: test/understand.test.ts ask (12): citation points at the sentence with the most question and answer terms; nothing matched gives found false and no answer-model call; model found false, citations 9/0/-1/2.5/"1", or empty are dropped; [1, 99] keeps 1; a transcript with "Ignore all previous instructions" and a fake closing excerpt tag: stripped from the prompt, system prompt forbids following it, a fooled reply "PWNED" gives not found; 409 while running or failed, 404 stranger, 400 for short, 301 chars and a number, 401 without login; model 429 gives 429, 500 gives 502, keyword 401 gives 502, keyword 500 still answers; limit 2 per minute: third is 429 and another user is unaffected

- [x] G9: no key configured: understanding is "off", search and ask say so with 503, the video still plays
  EVIDENCE: test/understand.test.ts no provider: search, ask and retry return 503, understanding and captions still 200; integration "no provider": video becomes "off", understand queue has 0 waiting, search 503

- [x] G10: delete and retry-from-failure remove transcript data and chunks
  EVIDENCE: test/understand.test.ts delete: chunks and transcript gone after DELETE; integration "delete while transcribing": delete during a running job, 5 s later 0 chunks, no transcript, no video; videos.retry also clears understanding fields

- [x] G11: in Chromium with the fake provider: captions track present, chapter list click seeks the player, search result click seeks, an answer shows its citations and clicking one seeks, "not found" shows plainly, no console errors
  EVIDENCE: playwright Chromium against the real API, worker and Vite with the fake provider, 11 PASS: 2 chapters listed, track has 4 cues, chapter click seeks to 23.3 (target 22), search "event loop" shows "0:14 The event loop runs one task at a time" and click seeks to 15.3, "zebra" shows Nothing found, answer shown with citation "0:06 A closure remembers the variables around it" and click seeks to 7.3, quantum question shows "does not seem to answer that" with no answer box, console errors []. First run found a real problem: the citation pointed at 0:00 because of a tie; the answer words now pick the sentence. Screenshots viewed

- [ ] G12: real Groq on real speech: transcript non-empty and timestamps match the audio, 10 labeled questions with the hit rate reported as measured
  EVIDENCE: pending

- [x] G13: code has no em dashes or curly quotes
  CHECK: grep -rlP "\x{2014}|\x{2013}|\x{201c}|\x{201d}" apps shared scripts test integration docs; echo scanned
  EXPECT: scanned
  EVIDENCE: scanned
