import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Redis } from 'ioredis'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { buildApp } from '../apps/api/src/app.js'
import { authService, type UserDoc } from '../apps/api/src/auth.js'
import { config } from '../apps/api/src/config.js'
import { makeAnalytics } from '../apps/api/src/analytics.js'
import { aiConfigured, groqAi, type Ai } from '../apps/api/src/ai.js'
import { understandService, understandStore, type ChunkDoc, type TranscriptDoc } from '../apps/api/src/understand.js'
import { keyStore, type KeyDoc } from '../apps/api/src/keys.js'
import { redisLease } from '../apps/api/src/lease.js'
import { playbackService } from '../apps/api/src/playback.js'
import { createQueues } from '../apps/api/src/queue.js'
import { realtime } from '../apps/api/src/realtime.js'
import { s3Storage } from '../apps/api/src/storage.js'
import { uploadService, type UploadDoc } from '../apps/api/src/uploads.js'
import { videoService, type VideoDoc } from '../apps/api/src/videos.js'
import { startWorkers } from '../apps/worker/src/run.js'
import { upload, type FileLike } from '../shared/uploader.js'

const sh = promisify(execFile)

export const needInfra = () => {
  for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'REDIS_URL']) {
    if (!process.env[k]) throw new Error(`integration tests need ${k}`)
  }
}

export async function makeSource(path: string, o: { seconds: number; size: string; audio?: boolean }) {
  await mkdir(dirname(path), { recursive: true })
  await sh('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${o.size}:rate=25:duration=${o.seconds}`,
    ...(o.audio === false ? [] : ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${o.seconds}`, '-c:a', 'aac']),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', path,
  ])
  return path
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function until<T>(fn: () => Promise<T | undefined | false | null>, ms = 120_000, every = 150): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(every)
  }
}

export async function makeStack(o: { workers?: boolean; lockMs?: number; encodeConcurrency?: number; ai?: Ai | null } = {}) {
  needInfra()
  const mongod = await MongoMemoryServer.create()
  const mongo = await MongoClient.connect(mongod.getUri())
  const db = mongo.db('it')
  const users = db.collection<UserDoc>('users')
  const uploadCol = db.collection<UploadDoc>('uploads')
  const videoCol = db.collection<VideoDoc>('videos')
  await users.createIndex({ email: 1 }, { unique: true })

  const storage = s3Storage()
  const queues = createQueues()
  const publisher = new Redis(config.redisUrl)
  const keyCol = db.collection<KeyDoc>('keys')
  const keyService = keyStore(keyCol)
  const leaseRedis = new Redis(config.redisUrl)
  const leasePrefix = `sv:lease:it${Date.now()}`
  const store = understandStore(db.collection<TranscriptDoc>('transcripts'), db.collection<ChunkDoc>('chunks'))
  await store.ensureIndexes()
  const ai = o.ai === undefined ? (aiConfigured() ? groqAi() : null) : o.ai
  const understand = understandService(videoCol, store, ai, (id, run, u) => queues.enqueueUnderstand(id, run, u))
  const analytics = makeAnalytics(db, ai)
  await analytics.ensureIndexes()
  const playback = playbackService(videoCol, keyService, redisLease(leaseRedis, leasePrefix), analytics)
  const videos = videoService(videoCol, uploadCol, storage, (id, run) => queues.enqueueProbe(id, run), keyService, (id) => Promise.all([store.removeVideo(id), analytics.removeVideo(id)]).then(() => {}))
  const uploads = uploadService(uploadCol, storage, (u) => videos.fromUpload(u))
  const app = buildApp({ uploads, auth: authService(users), videos, playback, storage, understand, analytics })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const live = realtime(app.server, config.redisUrl)
  const api = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  const s3 = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })

  const deps = { videos: videoCol, storage, queues, publisher, keys: keyService, ai, understandStore: store }
  let workers = o.workers === false ? undefined : await startWorkers(deps, { lockMs: o.lockMs, encodeConcurrency: o.encodeConcurrency })

  const call = (path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) =>
    fetch(api + path, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    })

  async function signup(email: string) {
    const res = await call('/api/auth/signup', { json: { email, password: 'a long test password' } })
    if (res.status !== 201) throw new Error(`signup ${res.status}`)
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!
    return { user: (await res.json()) as { id: string; email: string }, cookie, headers: { cookie } }
  }

  async function send(who: { headers: Record<string, string> }, path: string, name = 'clip.mp4') {
    const blob = await (await import('node:fs')).openAsBlob(path, { type: 'video/mp4' })
    const file = Object.assign(blob, { name, lastModified: Date.now() }) as FileLike
    return upload(file, { api, headers: who.headers })
  }

  const keys = async (prefix: string) => {
    const out: string[] = []
    let token: string | undefined
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }))
      out.push(...(page.Contents ?? []).map((c) => c.Key!))
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return out.sort()
  }

  // downloads everything under hls/<id>/ so ffmpeg can decode it from disk
  async function download(id: string) {
    const dir = await mkdtemp(join(tmpdir(), 'sv-dl-'))
    for (const key of await keys(`hls/${id}/`)) {
      const body = await (await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }))).Body!.transformToByteArray()
      const path = join(dir, key.slice(`hls/${id}/`.length))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
    }
    return dir
  }

  const waitFor = (id: string, status: VideoDoc['status'], ms?: number) =>
    until(async () => {
      const v = await videoCol.findOne({ _id: id })
      if (v?.status === 'failed' && status !== 'failed') throw new Error(`video failed: ${v.failure}`)
      return v?.status === status ? v : undefined
    }, ms)

  return {
    api, call, signup, send, keys, download, waitFor, s3, storage, queues, deps, mongod,
    videoCol, uploadCol, users, app, analytics, db, store, chunkCol: db.collection<ChunkDoc>('chunks'), keyService, keyCol, leaseRedis, leasePrefix,
    get workers() {
      return workers
    },
    async startWorkers(opts: { lockMs?: number; encodeConcurrency?: number } = {}) {
      workers = await startWorkers(deps, opts)
    },
    async stopWorkers() {
      await workers?.close()
      workers = undefined
    },
    async close() {
      await workers?.close()
      await live.close()
      await app.close()
      await queues.close()
      publisher.disconnect()
      leaseRedis.disconnect()
      await mongo.close()
      await mongod.stop()
    },
  }
}

export type Stack = Awaited<ReturnType<typeof makeStack>>

// Plays the video the way a viewer's player does: asks the API for a token, then lets ffmpeg
// fetch master, playlists and segments from /media and the keys from /api/keys with that token.
export async function decodeCheck(s: Pick<Stack, 'api' | 'call'>, who: { cookie: string }, id: string) {
  const res = await s.call(`/api/videos/${id}/playback`, { cookie: who.cookie, json: {} })
  if (res.status !== 200) throw new Error(`playback ${res.status}`)
  const { token, lease, master } = (await res.json()) as { token: string; lease: string; master: string }
  const url = s.api + master
  const headers = `Authorization: Bearer ${token}\r\n`
  const { stderr } = await sh('ffmpeg', ['-v', 'verbose', '-headers', headers, '-i', url, '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 })
  const { stdout } = await sh('ffprobe', ['-v', 'error', '-headers', headers, '-show_entries', 'format=duration', '-of', 'csv=p=0', url])
  const text = await (await fetch(url)).text()
  await s.call(`/api/videos/${id}/playback/stop`, { cookie: who.cookie, json: { lease } })
  const keyOpens = [...stderr.matchAll(/Opening '[^']*\/api\/keys\/[^/]+\/(\d+)'/g)].map((m) => Number(m[1]))
  return { duration: Number(stdout.trim()), master: text, keyOpens }
}
