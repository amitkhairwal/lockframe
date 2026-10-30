# Measuring transcription and Q&A

`scripts/eval-qa.ts` runs the real provider on one video you give it and reports what happened. It claims nothing by itself: the numbers come from the questions you label.

1. Put `GROQ_API_KEY=...` in `.env` (never in chat or in a commit).
2. Pick a video with speech that you know well, 5 to 30 minutes.
3. Write `questions.json` with about 10 entries. For each, watch the video and note where the answer is said.

```json
[
  { "q": "What is a closure?", "at": [95, 130] },
  { "q": "Why does a resolved promise log before setTimeout 0?", "at": [410, 470] },
  { "q": "What is the capital of France?", "at": null }
]
```

`at` is the start and end second where a person says the answer. `null` marks a question the video does not answer, to check that it refuses instead of guessing. Include at least 3 of those.

4. Run `npx tsx scripts/eval-qa.ts path/to/video.mp4 questions.json`.

It prints the transcript size, one row per question (did search land within 5 s of the labeled range, did the answer cite the right place, was a refusal correct) and three totals. Paste those totals into the README as they came out, with the video length and the date. If the labels were written after seeing the model's answers they prove nothing, so write them first.
