import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import type { AddressInfo } from 'node:net'
import { buildApp } from '../apps/api/src/app.js'
import { authService, type UserDoc } from '../apps/api/src/auth.js'
import { resetLimits } from '../apps/api/src/ratelimit.js'
import { uploadService, type UploadDoc } from '../apps/api/src/uploads.js'
import { videoService, type VideoDoc } from '../apps/api/src/videos.js'
import { keyStore, type KeyDoc } from '../apps/api/src/keys.js'
import { memoryLease } from '../apps/api/src/lease.js'
import { playbackService } from '../apps/api/src/playback.js'
import { makeAnalytics } from '../apps/api/src/analytics.js'
import type { Ai } from '../apps/api/src/ai.js'
import { understandService, understandStore, type ChunkDoc, type TranscriptDoc } from '../apps/api/src/understand.js'
import { fakeStorage } from './fakeStorage.js'

// Real app, in-memory Mongo, fake S3. One per test file.
export async function harness(o: { ai?: Ai | null } = {}) {
  const clock = { now: Date.now() }
  const mongod = await MongoMemoryServer.create()
  const mongo = await MongoClient.connect(mongod.getUri())
  const db = mongo.db('t')
  const users = db.collection<UserDoc>('users')
  const uploadCol = db.collection<UploadDoc>('uploads')
  const videoCol = db.collection<VideoDoc>('videos')
  await users.createIndex({ email: 1 }, { unique: true })

  const fake = await fakeStorage()
  const keyCol = db.collection<KeyDoc>('keys')
  const keys = keyStore(keyCol)
  const lease = memoryLease(() => clock.now)
  const chunkCol = db.collection<ChunkDoc>('chunks')
  const store = understandStore(db.collection<TranscriptDoc>('transcripts'), chunkCol)
  await store.ensureIndexes()
  const understand = understandService(videoCol, store, o.ai ?? null)
  const analytics = makeAnalytics(db, o.ai ?? null, () => new Date(clock.now))
  await analytics.ensureIndexes()
  const videos = videoService(videoCol, uploadCol, fake.storage, undefined, keys, (id) => Promise.all([store.removeVideo(id), analytics.removeVideo(id)]).then(() => {}))
  const playback = playbackService(videoCol, keys, lease, analytics)
  const uploads = uploadService(uploadCol, fake.storage, (u) => videos.fromUpload(u))
  const app = buildApp({ uploads, auth: authService(users), videos, playback, storage: fake.storage, understand, analytics })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const api = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  const call = (path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) =>
    fetch(api + path, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    })

  async function signup(email: string, password = 'correct horse battery') {
    resetLimits()
    const res = await call('/api/auth/signup', { json: { email, password } })
    if (res.status !== 201) throw new Error(`signup ${res.status}`)
    const user = (await res.json()) as { id: string; email: string }
    return { user, cookie: res.headers.getSetCookie()[0]!.split(';')[0]!, headers: { cookie: res.headers.getSetCookie()[0]!.split(';')[0]! } }
  }

  return {
    api,
    call,
    signup,
    app,
    fake,
    uploads,
    videos,
    keys,
    analytics,
    db,
    store,
    chunkCol,
    keyCol,
    clock,
    lease,
    users,
    uploadCol,
    videoCol,
    async close() {
      await app.close()
      await fake.close()
      await mongo.close()
      await mongod.stop()
    },
  }
}

export type Harness = Awaited<ReturnType<typeof harness>>
