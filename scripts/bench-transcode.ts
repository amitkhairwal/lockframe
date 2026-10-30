// Throughput of the transcode pipeline with 1, 2 and 4 worker processes.
// Needs S3_*, REDIS_URL and ffmpeg. Videos are inserted directly (no HTTP upload) and all point at one source object.
// Env: SECONDS (clip length, default 20), VIDEOS (default 4), THREADS (ffmpeg threads per job, default 2), WORKERS (default 1,2,4).
import { execFile, spawn } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { config } from '../apps/api/src/config.js'
import { createQueues } from '../apps/api/src/queue.js'
import { s3Storage } from '../apps/api/src/storage.js'
import type { VideoDoc } from '../apps/api/src/videos.js'

const sh = promisify(execFile)
const seconds = Number(process.env.SECONDS ?? 20)
const videosPerRun = Number(process.env.VIDEOS ?? 4)
const threads = process.env.THREADS ?? '2'
const counts = (process.env.WORKERS ?? '1,2,4').split(',').map(Number)

const work = await mkdtemp(join(tmpdir(), 'sv-bench-'))
const src = join(work, 'src.mp4')
await sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])

const storage = s3Storage()
await storage.putFile('raw/bench/src.mp4', src, 'video/mp4')

const mongod = await MongoMemoryServer.create()
const mongo = await MongoClient.connect(mongod.getUri())
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!

const results = []
for (const n of counts) {
  const prefix = `bench${Date.now()}n${n}`
  const dbName = `bench_${n}`
  const col = mongo.db(dbName).collection<VideoDoc>('videos')
  const queues = createQueues(config.redisUrl, prefix)

  const workers = Array.from({ length: n }, () =>
    spawn('node', ['--import', 'tsx', 'apps/worker/src/index.ts'], {
      stdio: 'ignore',
      env: { ...process.env, MONGODB_URI: mongod.getUri(dbName), QUEUE_PREFIX: prefix, FFMPEG_THREADS: threads, ENCODE_CONCURRENCY: '1', TMP_DIR: join(work, `tmp${n}`) },
    }),
  )
  await new Promise((r) => setTimeout(r, 4000)) // let them connect before the clock starts

  const ids = Array.from({ length: videosPerRun }, (_, i) => `bench-${n}-${i}`)
  const t0 = Date.now()
  for (const id of ids) {
    await col.insertOne({ _id: id, owner: 'bench', title: id, status: 'uploaded', size: 0, createdAt: new Date(), viewers: [], rawKey: 'raw/bench/src.mp4', run: 1, progress: 0 })
    await queues.enqueueProbe(id, 1)
  }
  for (;;) {
    const done = await col.countDocuments({ status: { $in: ['ready', 'failed'] } })
    if (done === ids.length) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const wallMs = Math.max(...(await col.find().toArray()).map((v) => v.readyAt?.getTime() ?? 0)) - t0
  const docs = await col.find().toArray()
  const failed = docs.filter((v) => v.status !== 'ready').length

  const encodes = docs.flatMap((v) => Object.entries(v.timings ?? {}).filter(([k]) => k.startsWith('encode_')).map(([, t]) => t))
  results.push({
    workers: n,
    videos: ids.length,
    encodeJobs: encodes.length,
    failed,
    wallSeconds: +(wallMs / 1000).toFixed(1),
    videoSecondsPerWallSecond: +((ids.length * seconds) / (wallMs / 1000)).toFixed(2),
    queueWaitP50: Math.round(percentile(encodes.map((e) => e.waitMs), 50)),
    queueWaitP95: Math.round(percentile(encodes.map((e) => e.waitMs), 95)),
    encodeMsPerJobMean: Math.round(encodes.reduce((s, e) => s + e.ms, 0) / encodes.length),
  })
  console.log(JSON.stringify(results.at(-1)))

  for (const w of workers) w.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 2000))
  await queues.close()
}

console.log('\nmachine:', cpus()[0]!.model.trim(), `${cpus().length} threads`, `${Math.round(totalmem() / 2 ** 30)} GB RAM`)
console.log('clip:', `${seconds}s 1080p25 testsrc2 + sine, ${videosPerRun} videos x 4 rungs per run, ffmpeg -threads ${threads}`)
console.log((await sh('ffmpeg', ['-version'])).stdout.split('\n')[0])
await storage.deletePrefix('raw/bench/')
for (const n of counts) await storage.deletePrefix(`hls/bench-${n}-`)
await mongo.close()
await mongod.stop()
await rm(work, { recursive: true, force: true })
process.exit(0)
