import { MongoClient } from 'mongodb'
import { buildApp } from './app.js'
import { authService, type UserDoc } from './auth.js'
import { config } from './config.js'
import { Redis } from 'ioredis'
import { makeAnalytics } from './analytics.js'
import { aiConfigured, groqAi } from './ai.js'
import { understandService, understandStore, type ChunkDoc, type TranscriptDoc } from './understand.js'
import { keyStore, type KeyDoc } from './keys.js'
import { redisLease } from './lease.js'
import { playbackService } from './playback.js'
import { createQueues } from './queue.js'
import { realtime } from './realtime.js'
import { s3Storage } from './storage.js'
import { uploadService, type UploadDoc } from './uploads.js'
import { videoService, type VideoDoc } from './videos.js'

void config.sessionSecret // fail fast in production when it is missing
const mongo = await MongoClient.connect(config.mongoUri)
const db = mongo.db()
const users = db.collection<UserDoc>('users')
const uploadCol = db.collection<UploadDoc>('uploads')
const videoCol = db.collection<VideoDoc>('videos')

await Promise.all([
  users.createIndex({ email: 1 }, { unique: true }),
  uploadCol.createIndex({ status: 1, createdAt: 1 }),
  videoCol.createIndex({ owner: 1, createdAt: -1 }),
  videoCol.createIndex({ viewers: 1 }),
])

const storage = s3Storage()
const queues = createQueues()
const keys = keyStore(db.collection<KeyDoc>('keys'))
await keys.ensureIndex()
const leaseRedis = new Redis(config.redisUrl)
const store = understandStore(db.collection<TranscriptDoc>('transcripts'), db.collection<ChunkDoc>('chunks'))
await store.ensureIndexes()
const ai = aiConfigured() ? groqAi() : null
const analytics = makeAnalytics(db, ai)
await analytics.ensureIndexes()
const videos = videoService(videoCol, uploadCol, storage, (id, run) => queues.enqueueProbe(id, run), keys, (id) => Promise.all([store.removeVideo(id), analytics.removeVideo(id)]).then(() => {}))
const understand = understandService(videoCol, store, ai, (id, run, u) => queues.enqueueUnderstand(id, run, u))
const playback = playbackService(videoCol, keys, redisLease(leaseRedis), analytics)
const uploads = uploadService(uploadCol, storage, (u) => videos.fromUpload(u))
const app = buildApp({ uploads, auth: authService(users), videos, playback, storage, understand, analytics })

const sweep = setInterval(() => uploads.sweepStale().catch((e) => app.log.error(e)), 3600_000)
sweep.unref()

await app.ready()
const live = realtime(app.server, config.redisUrl)

const stop = async () => {
  clearInterval(sweep)
  await live.close()
  await app.close()
  await queues.close()
  leaseRedis.disconnect()
  await mongo.close()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)

await app.listen({ port: config.port, host: '0.0.0.0' })
