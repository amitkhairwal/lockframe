import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { config } from '../../api/src/config.js'
import { keyStore, type KeyDoc } from '../../api/src/keys.js'
import { aiConfigured, groqAi } from '../../api/src/ai.js'
import { understandStore, type ChunkDoc, type TranscriptDoc } from '../../api/src/understand.js'
import { createQueues } from '../../api/src/queue.js'
import { s3Storage } from '../../api/src/storage.js'
import type { VideoDoc } from '../../api/src/videos.js'
import { startWorkers } from './run.js'

const mongo = await MongoClient.connect(config.mongoUri)
const publisher = new Redis(config.redisUrl)
const queues = createQueues()
const workers = await startWorkers({ videos: mongo.db().collection<VideoDoc>('videos'), storage: s3Storage(), queues, publisher, keys: keyStore(mongo.db().collection<KeyDoc>('keys')), ai: aiConfigured() ? groqAi() : null, understandStore: understandStore(mongo.db().collection<TranscriptDoc>('transcripts'), mongo.db().collection<ChunkDoc>('chunks')) })
console.log(`worker ${process.pid} ready, encode concurrency ${config.worker.encodeConcurrency}`)

let closing = false
const stop = async () => {
  if (closing) return
  closing = true
  await workers.close()
  await queues.close()
  publisher.disconnect()
  await mongo.close()
  process.exit(0)
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
