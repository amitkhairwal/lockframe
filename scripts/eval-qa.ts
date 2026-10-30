// Measures transcription, search and Q&A on one real video with the real provider.
// Needs GROQ_API_KEY and ffmpeg. No S3 or Redis: it runs the same code on a local file and an in-memory Mongo.
//   npx tsx scripts/eval-qa.ts <video file> <questions.json>
// questions.json: [{ "q": "...", "at": [startSeconds, endSeconds] }, { "q": "...", "at": null }]
// "at" is where a person says the answer is. null means the video does not answer it, so the right reply is "not found".
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { aiConfigured, groqAi } from '../apps/api/src/ai.js'
import { config } from '../apps/api/src/config.js'
import { audioPieces, mergePieces, type Segment } from '../apps/api/src/transcript.js'
import { understandService, understandStore, type ChunkDoc, type TranscriptDoc } from '../apps/api/src/understand.js'
import type { VideoDoc } from '../apps/api/src/videos.js'
import { extractAudio, probe } from '../apps/worker/src/ffmpeg.js'

const [file, questionsFile] = process.argv.slice(2)
if (!file || !questionsFile) throw new Error('usage: tsx scripts/eval-qa.ts <video> <questions.json>')
if (!aiConfigured()) throw new Error('set GROQ_API_KEY first')
const questions = JSON.parse(await readFile(questionsFile, 'utf8')) as { q: string; at: [number, number] | null }[]

const ai = groqAi()
const source = await probe(file)
const dir = await mkdtemp(join(tmpdir(), 'sv-eval-'))
const t0 = Date.now()
const plan = audioPieces(source.duration, config.ai.pieceSeconds, config.ai.overlapSeconds)
const pieces: Segment[][] = []
for (const [i, p] of plan.entries()) {
  const path = join(dir, `p${i}.mp3`)
  await extractAudio({ input: file, outPath: path, start: p.offset, length: p.length })
  pieces.push(await ai.transcribe(await readFile(path), `p${i}.mp3`))
}
await rm(dir, { recursive: true, force: true })
const segments = mergePieces(plan.map((p, i) => ({ offset: p.offset, overlap: p.overlap, segments: pieces[i]! })))
console.log(`video ${source.duration.toFixed(0)} s, ${plan.length} audio pieces, ${segments.length} segments, transcribed in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
console.log('first segments:', segments.slice(0, 3).map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join(' | '))

const mongod = await MongoMemoryServer.create()
const mongo = await MongoClient.connect(mongod.getUri())
const db = mongo.db('eval')
const videos = db.collection<VideoDoc>('videos')
const store = understandStore(db.collection<TranscriptDoc>('transcripts'), db.collection<ChunkDoc>('chunks'))
await store.ensureIndexes()
await videos.insertOne({ _id: 'eval', owner: 'u', title: 'eval', status: 'ready', size: 0, createdAt: new Date(), viewers: [], rawKey: '', run: 1, progress: 100, duration: source.duration, understanding: 'done' })
await store.finish('eval', segments, [])
const service = understandService(videos, store, ai)
const user = { id: 'u', email: 'u@example.com' }

const rows = []
for (const item of questions) {
  const hits = await service.search(user, item.q, 'eval')
  const searchHit = item.at ? hits.some((h) => h.start >= item.at![0] - 5 && h.start <= item.at![1] + 5) : null
  const answer = await service.ask(user, 'eval', item.q).catch((e: Error) => ({ found: false as const, answer: `error: ${e.message}`, citations: [] }))
  const cited = item.at ? answer.citations.some((c) => c.start >= item.at![0] - 5 && c.start <= item.at![1] + 5) : null
  const correct = item.at ? answer.found && cited === true : !answer.found
  rows.push({ q: item.q, expect: item.at ? `${item.at[0]}-${item.at[1]} s` : 'not found', searchHit, found: answer.found, cited, correct, answer: answer.answer.slice(0, 120) })
  await new Promise((r) => setTimeout(r, 1500)) // stay under the free tier request rate
}
console.table(rows.map(({ answer, ...r }) => r))
const withAnswer = rows.filter((r) => r.expect !== 'not found')
const without = rows.filter((r) => r.expect === 'not found')
console.log(`search finds the right place: ${withAnswer.filter((r) => r.searchHit).length}/${withAnswer.length}`)
console.log(`answer found with a citation in the right place: ${withAnswer.filter((r) => r.correct).length}/${withAnswer.length}`)
console.log(`correctly refused when the video has no answer: ${without.filter((r) => r.correct).length}/${without.length}`)
for (const r of rows) console.log(`- ${r.correct ? 'ok  ' : 'MISS'} ${r.q} -> ${r.answer}`)
await mongo.close()
await mongod.stop()
process.exit(0)
