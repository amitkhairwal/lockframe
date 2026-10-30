# Security notes

This is a list of what each protection stops, the test that shows it, and then, separately, what it does not stop. Test paths are relative to the repo root.

## What is protected

| Attack | What stops it | Shown by |
|---|---|---|
| Copying a playlist or segment URL and sharing it | Every segment is AES-128 encrypted before it reaches storage, and keys live only in Mongo. A URL without a key is noise. | `integration/pipeline.int.test.ts` "stores only encrypted output". `test/hls-crypto.test.ts`: "stores nothing a player can use without the key" and "does not decode to the real video with a wrong key". |
| Asking the key route with no credentials, a garbage token, an expired token | Bearer token with its own audience, signed, 2 minute life | `test/playback.test.ts` "key route" (401 for each) |
| Using a login cookie as a playback token, or the reverse | Different JWT audience. The key route reads only the Authorization header, never the cookie, so a page on another site cannot get keys by riding the session. | `test/playback.test.ts` "refuses: no token, cookie only, garbage, a session cookie used as a token" |
| A token for one video used on another | The token carries the video id and the route compares it | `test/playback.test.ts` (403) |
| A viewer who lost access still watching on an old token | Access is checked in Mongo on every key request, not only when the token is minted | `test/playback.test.ts` "access was withdrawn"; `integration/playback.int.test.ts` |
| One login watching on two devices | One lease per user and video in Redis. The lease id is made by the server, so a second device cannot guess it. A refused attempt is counted. | `test/playback.test.ts` "one device at a time"; `integration/playback.int.test.ts` "device lease on real Redis" including the TTL |
| A key stolen early unlocking the whole video | Keys rotate every 5 segments (30 s), so one key opens 30 s | `integration/playback.int.test.ts` "stores a different key per group" |
| A stranger probing for video ids | Videos and uploads you do not own answer 404, the same as a missing one | `test/access.test.ts`, `test/playback.test.ts` |
| Guessing passwords, or finding which emails exist | scrypt with a per-user salt, a decoy hash for unknown emails so timing should match, 10 attempts a minute per address | `test/auth.test.ts`: "stores a salted scrypt hash, never the password", "gives the same answer for a wrong password and an unknown email", "limits auth attempts per address". The decoy hash that evens out timing is in `apps/api/src/auth.ts`; no test measures the timing |
| Reusing a session stolen from a script | httpOnly, SameSite=Lax cookie, Secure in production, `JWT_SECRET` required in production | `test/auth.test.ts`: "creates a user and sets a hardened session cookie", "refuses a tampered token", "refuses an expired token", "refuses an unsigned token (alg none)", "refuses to start in production without a strong JWT_SECRET", "marks the cookie Secure in production" |
| Uploading different bytes than were signed | Each part is signed with its SHA-256, storage refuses a mismatch | `scripts/upload-check.ts` ("storage refused a part with the wrong bytes", status 400), run against SeaweedFS |
| A non-video file becoming a "video" | ffprobe is the check, not the content type. The file is deleted and the video marked failed. | `integration/pipeline.int.test.ts` "not a video" |
| Prompt injection from the transcript into answers | Excerpts are fenced, the system prompt says not to follow them, the reply must be JSON with citations that point at real excerpts, anything else becomes "not found". The answer is shown as text, never as markup. | `test/understand.test.ts` "is not hijacked by instructions inside the transcript" |
| Leaking the provider key | It is read from the environment, scrubbed from error messages, and not sent anywhere but the provider | `test/ai.test.ts` "never puts the key in an error" |
| Leaking a presigned URL through logs | ffmpeg errors have the URL removed | `apps/worker/src/ffmpeg.ts` (`scrub`), `integration/lifecycle.int.test.ts` (failure text has no `X-Amz-Signature`) |
| Flooding the expensive routes | In-memory fixed window limits on login, upload creation, key route, search, ask, events | `test/auth.test.ts` (login, upload creation), `test/understand.test.ts` "limits how fast one user can ask", `test/analytics.test.ts` (events). The key route and search limits have no test of their own |
| Form posts from another site | JSON bodies only, anything else is 415 | `test/auth.test.ts` "does not take form posts" |

## What is not stopped

- **Screen recording.** Nothing in the browser can stop it. The moving watermark with the viewer's email only discourages sharing.
- **The watermark can be removed.** It is a page element, not burned into the video. Anyone with dev tools can delete it. A forensic watermark per viewer would need a separate encode for each viewer. That is not built.
- **A valid viewer collecting keys.** A script with a valid token can fetch the keys of a video it is allowed to watch, one group at a time, and decrypt it offline. The flags try to notice keys requested far ahead of the playhead, but the playhead position comes from the player, so a script that reports a fake position avoids that rule. This is gated AES-128, not DRM.
- **Keys in the database.** They are stored as plain bytes. Someone with the database also has the keys. Wrapping them with a server secret is not done.
- **Safari's native HLS** cannot send the token header, so the player shows a message there. Not tested in Safari.
- **Rate limits are per process and in memory.** With two API instances each has its own counters, and a restart resets them.
- **`/media` has no login.** It serves only encrypted objects from `hls/`, by a strict path pattern. In production the plan is a bucket or CDN, and then the API serves none of it.
- **The flag thresholds are guesses.** They have not seen real traffic.
- **Nothing has had an outside review.** No penetration test. `npm audit --omit=dev` found 0 problems on 2026-10-30. Plain `npm audit` flags 3 in the test runner (vitest and its tinypool and mocker packages, 2 rated critical, 1 moderate). They are dev only and do not ship, and the fix is a major version bump that I have not tried.
