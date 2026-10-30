// Latency of the playback start and the key route under concurrent viewers.
// Needs REDIS_URL. Mongo is in memory and storage is not touched (the key route reads only Mongo and Redis).
// Env: VIEWERS (default 50), REQUESTS (key requests per viewer, default 40), WARMUP (default 200),
// NO_ANALYTICS=1 leaves out the event writes and flag rules, to show what they cost.
import { cpus, totalmem } from 'node:os'
import type { AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { buildApp } from '../apps/api/src/app.js'
import { makeAnalytics } from '../apps/api/src/analytics.js'
import { authService, type UserDoc } from '../apps/api/src/auth.js'
import { config } from '../apps/api/src/config.js'
import { keyStore, type KeyDoc } from '../apps/api/src/keys.js'
import { redisLease } from '../apps/api/src/lease.js'
import { playbackService } from '../apps/api/src/playback.js'
import { uploadService, type UploadDoc } from '../apps/api/src/uploads.js'
import { understandService, understandStore, type ChunkDoc, type TranscriptDoc } from '../apps/api/src/understand.js'
import { videoService, type VideoDoc } from '../apps/api/src/videos.js'
import { fakeStorage } from '../test/fakeStorage.js'

const viewers = Number(process.env.VIEWERS ?? 50)
const perViewer = Number(process.env.REQUESTS ?? 40)
const warmup = Number(process.env.WARMUP ?? 200)

const mongod = await MongoMemoryServer.create()
const mongo = await MongoClient.connect(mongod.getUri())
const db = mongo.db('bench')
const users = db.collection<UserDoc>('users')
await users.createIndex({ email: 1 }, { unique: true })
const videoCol = db.collection<VideoDoc>('videos')
const keys = keyStore(db.collection<KeyDoc>('keys'))
const redis = new Redis(config.redisUrl)
const fake = await fakeStorage()
const analytics = makeAnalytics(db, null)
await analytics.ensureIndexes()
const store = understandStore(db.collection<TranscriptDoc>('transcripts'), db.collection<ChunkDoc>('chunks'))
const videos = videoService(videoCol, db.collection<UploadDoc>('uploads'), fake.storage, undefined, keys)
const app = buildApp({
  uploads: uploadService(db.collection<UploadDoc>('uploads'), fake.storage, (u) => videos.fromUpload(u)),
  auth: authService(users),
  videos,
  playback: playbackService(videoCol, keys, redisLease(redis, `sv:lease:bench${Date.now()}`), process.env.NO_ANALYTICS ? undefined : analytics),
  storage: fake.storage,
  understand: understandService(videoCol, store, null),
  analytics,
})
// one address makes every request here, so lift the per-address limit for this run only
config.keysPerMinute = 1e9
await app.listen({ port: 0, host: '127.0.0.1' })
const api = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

await videoCol.insertOne({ _id: 'bench', owner: 'x', title: 'bench', status: 'ready', size: 1, createdAt: new Date(), viewers: [], rawKey: 'r', run: 1, progress: 100, duration: 7200 })
for (let g = 0; g < 240; g++) await keys.getOrCreate('bench', g) // a 2 hour video

// scrypt signup is slow on purpose, so sign session cookies directly
const { signSession } = await import('../apps/api/src/auth.js')
const people = await Promise.all(
  Array.from({ length: viewers }, async (_, i) => {
    const user = { id: `user-${i}`, email: `u${i}@bench.test` }
    await videoCol.updateOne({ _id: 'bench' }, { $addToSet: { viewers: user.email } })
    return { cookie: `sv_session=${await signSession(user)}` }
  }),
)

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!
const ms = (n: number) => +n.toFixed(1)
const row = (name: string, xs: number[], seconds: number, errors: number) => ({
  name: name + (process.env.NO_ANALYTICS ? ', no analytics' : ''),
  requests: xs.length + errors,
  errors,
  perSecond: Math.round(xs.length / seconds),
  p50: ms(pct(xs, 50)),
  p95: ms(pct(xs, 95)),
  p99: ms(pct(xs, 99)),
  max: ms(Math.max(...xs)),
})

async function timed(fn: () => Promise<Response>) {
  const t = performance.now()
  const res = await fn()
  await res.arrayBuffer()
  return { ms: performance.now() - t, ok: res.ok }
}

// warm the code paths and the connections before the clock matters
for (let i = 0; i < warmup; i++) await fetch(`${api}/healthz`)

// 1. every viewer starts playback at the same moment: login check, access check, Redis lease, token, event write
const t0 = performance.now()
const started = await Promise.all(
  people.map(async (p) => {
    const t = performance.now()
    const res = await fetch(`${api}/api/videos/bench/playback`, { method: 'POST', headers: { cookie: p.cookie, 'content-type': 'application/json' }, body: '{}' })
    const body = (await res.json()) as { token?: string }
    return { ms: performance.now() - t, ok: res.ok, token: body.token! }
  }),
)
const startSeconds = (performance.now() - t0) / 1000

// 2. each viewer asks for keys one after another while all viewers run at once. Every request checks the token,
// the access in Mongo, the lease in Redis, reads the key, writes an event and runs the flag rules.
const t1 = performance.now()
const results = (
  await Promise.all(
    started.map(async (s, i) => {
      const out: { ms: number; ok: boolean }[] = []
      for (let n = 0; n < perViewer; n++) out.push(await timed(() => fetch(`${api}/api/keys/bench/${(i + n) % 240}`, { headers: { authorization: `Bearer ${s.token}` } })))
      return out
    }),
  )
).flat()
const keySeconds = (performance.now() - t1) / 1000

const table = [
  row(`playback start (${viewers} at once)`, started.filter((s) => s.ok).map((s) => s.ms), startSeconds, started.filter((s) => !s.ok).length),
  row(`key request (${viewers} viewers x ${perViewer})`, results.filter((r) => r.ok).map((r) => r.ms), keySeconds, results.filter((r) => !r.ok).length),
]
console.table(table)
console.log('machine:', cpus()[0]!.model.trim(), `${cpus().length} threads`, `${Math.round(totalmem() / 2 ** 30)} GB RAM`, '| node', process.version)
console.log('everything (API, Mongo, Redis, the load generator) shares this machine; times are milliseconds')
await app.close()
await fake.close()
redis.disconnect()
await mongo.close()
await mongod.stop()
process.exit(0)
