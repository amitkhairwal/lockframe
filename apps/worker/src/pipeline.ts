import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DelayedError, UnrecoverableError, type Job } from 'bullmq'
import type { Collection } from 'mongodb'
import type { Redis } from 'ioredis'
import { config } from '../../api/src/config.js'
import { jobId, QUEUE, type EncodeData, type ProbeData, type Queues } from '../../api/src/queue.js'
import { VIDEO_CHANNEL, type VideoEvent } from '../../api/src/redis.js'
import type { KeyStore } from '../../api/src/keys.js'
import type { Storage } from '../../api/src/storage.js'
import type { VideoDoc } from '../../api/src/videos.js'
import { encryptPlaylist, encryptSegment } from './crypto.js'
import { Aborted, encodeRung, grabFrame, probe } from './ffmpeg.js'
import { InvalidMedia, masterPlaylist, peakBandwidth, pickLadder, rungWidth } from './media.js'

const SIX_HOURS = 6 * 3600
const PROGRESS_EVERY_MS = 1000
const UPLOAD_LANES = 4
const PROBE_SHARE = 3 // percent of the bar spent before encoding starts
const TMP_PREFIX = 'sv-'

export interface Deps {
  videos: Collection<VideoDoc>
  storage: Storage
  queues: Queues
  publisher: Redis
  keys: KeyStore
  understand?: { enabled: boolean } // when off, videos are marked and no job is queued
}

const hlsKey = (id: string, ...rest: (string | number)[]) => ['hls', id, ...rest].join('/')
export const thumbKey = (id: string) => `thumbs/${id}.jpg`
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

export function pipeline(deps: Deps) {
  const { videos, storage, queues, publisher, keys } = deps
  const active = new Set<AbortController>()
  let stopping = false

  const announce = (v: Pick<VideoDoc, '_id' | 'owner' | 'status' | 'progress' | 'failure' | 'retryable'>) =>
    publisher.publish(
      VIDEO_CHANNEL,
      JSON.stringify({ id: v._id, owner: v.owner, status: v.status, progress: v.progress, failure: v.failure, retryable: v.retryable } satisfies VideoEvent),
    )

  // is this job still about the current run of a video that still exists?
  const current = (id: string, run: number) => videos.findOne({ _id: id, run, status: { $in: ['uploaded', 'processing'] } })

  async function timed<T>(job: Job, name: string, fn: () => Promise<T>) {
    const started = Date.now()
    const waitMs = Math.max(0, (job.processedOn ?? started) - job.timestamp)
    const result = await fn()
    await videos.updateOne({ _id: job.data.videoId }, { $set: { [`timings.${name}`]: { waitMs, ms: Date.now() - started } } })
    return result
  }

  async function failVideo(id: string, run: number, reason: string, o: { retryable: boolean; dropSource?: boolean }) {
    const v = await videos.findOneAndUpdate(
      { _id: id, run, status: { $in: ['uploaded', 'processing'] } },
      { $set: { status: 'failed', failure: reason, retryable: o.retryable } },
      { returnDocument: 'after' },
    )
    if (!v) return
    await storage.deletePrefix(hlsKey(id) + '/')
    await keys.removeVideo(id)
    if (o.dropSource) await storage.deletePrefix(`raw/${id}/`)
    await announce(v)
  }

  // A still for the library. It is not encrypted, so it lives outside hls/ and is only served behind a login.
  // A missing thumbnail is never worth failing the video over.
  async function saveThumbnail(id: string, rawKey: string, duration: number) {
    const out = join(config.media.tmpDir, `${TMP_PREFIX}thumb-${id}.jpg`)
    try {
      await mkdir(config.media.tmpDir, { recursive: true })
      await grabFrame({ input: await storage.presignGet(rawKey, 600), outPath: out, at: Math.min(duration * 0.1, 30) })
      await storage.putFile(thumbKey(id), out, 'image/jpeg')
    } catch (err) {
      console.error(`thumbnail for ${id} skipped:`, message(err))
    } finally {
      await rm(out, { force: true })
    }
  }

  async function probeJob(job: Job<ProbeData>) {
    const { videoId, run } = job.data
    const v = await current(videoId, run)
    if (!v) return 'skipped'

    return timed(job, 'probe', async () => {
      let source
      try {
        source = await probe(await storage.presignGet(v.rawKey, SIX_HOURS))
      } catch (err) {
        if (err instanceof InvalidMedia) {
          await failVideo(videoId, run, err.message, { retryable: false, dropSource: true })
          throw new UnrecoverableError(err.message)
        }
        throw err
      }

      const ladder = pickLadder(source.height)
      const renditions = ladder.map((r) => ({ height: r.height, width: rungWidth(source, r.height), progress: 0 }))
      const updated = await videos.findOneAndUpdate(
        { _id: videoId, run },
        { $set: { status: 'processing', source, duration: source.duration, renditions, progress: PROBE_SHARE }, $unset: { failure: '', retryable: '' } },
        { returnDocument: 'after' },
      )
      if (!updated) return 'skipped'
      await announce(updated)

      await saveThumbnail(videoId, v.rawKey, source.duration)

      // a retried probe must not queue the encodes twice
      if (await queues.finalize.getJob(jobId.finalize(videoId, run))) return 'already-queued'
      await queues.flow.add({
        name: 'finalize',
        queueName: QUEUE.finalize,
        data: { videoId, run },
        opts: { jobId: jobId.finalize(videoId, run), ...flowJobOptions() },
        children: ladder.map((rung) => ({
          name: 'encode',
          queueName: QUEUE.encode,
          data: { videoId, run, rung, hasAudio: source.hasAudio, duration: source.duration } satisfies EncodeData,
          opts: { jobId: jobId.encode(videoId, run, rung.height), failParentOnFailure: true, ...flowJobOptions() },
        })),
      })
      return 'queued'
    })
  }

  const flowJobOptions = () => ({
    attempts: config.worker.attempts,
    backoff: { type: 'exponential', delay: config.worker.backoffMs },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 86400 },
  })

  async function encodeJob(job: Job<EncodeData>, token?: string) {
    const { videoId, run, rung, hasAudio, duration } = job.data
    const start = await current(videoId, run)
    if (!start || start.status !== 'processing') return 'skipped'

    return timed(job, `encode_${rung.height}`, async () => {
      const dir = await mkdtemp(join(config.media.tmpDir, TMP_PREFIX))
      const ctl = new AbortController()
      active.add(ctl)
      let lastTick = 0
      let gone = false
      let pending: Promise<unknown> = Promise.resolve() // progress writes in order, and all done before the rung is

      // also the place where we notice the video was deleted or failed while we encode
      const onProgress = (percent: number) => {
        const now = Date.now()
        if (now - lastTick < PROGRESS_EVERY_MS) return
        lastTick = now
        pending = pending
          .then(() => saveProgress(videoId, run, rung.height, percent))
          .then((v) => {
            if (!v || v.status !== 'processing') {
              gone = true
              ctl.abort()
            }
          })
          .catch(() => {}) // a missed progress tick is not worth failing the encode
      }

      try {
        await storage.deletePrefix(hlsKey(videoId, rung.height) + '/') // a retry replaces its own output
        const input = await storage.presignGet(start.rawKey, SIX_HOURS)
        await encodeRung({ input, outDir: dir, rung, source: { duration, height: rung.height, hasAudio }, onProgress, signal: ctl.signal })
        await pending

        const files = await readdir(dir)
        const segments = files.filter((f) => f.endsWith('.ts')).sort()
        if (!segments.length) throw new Error('ffmpeg produced no segments')
        const plain = await readFile(join(dir, 'index.m3u8'), 'utf8')
        if ((plain.match(/#EXTINF/g) ?? []).length !== segments.length) throw new Error('playlist and segment count differ')

        // one key per rotation group, shared by every rung because the cuts are identical
        const perKey = config.hls.segmentsPerKey
        const groups = Math.ceil(segments.length / perKey)
        const groupKeys = await Promise.all(Array.from({ length: groups }, (_, g) => keys.getOrCreate(videoId, g)))
        const { text: playlist } = encryptPlaylist(plain, { perKey, keyUri: (g) => `${config.hls.keyUrlBase}/api/keys/${videoId}/${g}` })

        // segments first, the playlist last: a playlist in storage means the rung is complete
        let next = 0
        let bytes = 0
        await Promise.all(
          Array.from({ length: UPLOAD_LANES }, async () => {
            for (let i = next++; i < segments.length; i = next++) {
              ctl.signal.throwIfAborted()
              // no plaintext segment ever reaches storage
              const clear = await readFile(join(dir, segments[i]!))
              bytes += clear.length
              await storage.put(hlsKey(videoId, rung.height, segments[i]!), encryptSegment(clear, groupKeys[Math.floor(i / perKey)]!, i), 'video/mp2t')
            }
          }),
        )
        await storage.put(hlsKey(videoId, rung.height, 'index.m3u8'), playlist, 'application/vnd.apple.mpegurl')

        const v = await videos.findOneAndUpdate(
          { _id: videoId, run },
          { $set: { 'renditions.$[r].progress': 100, 'renditions.$[r].bandwidth': peakBandwidth(rung, hasAudio), 'renditions.$[r].segments': segments.length, 'renditions.$[r].bytes': bytes } },
          { arrayFilters: [{ 'r.height': rung.height }], returnDocument: 'after' },
        )
        if (v) await announce({ ...v, progress: overall(v) })
        return 'encoded'
      } catch (err) {
        if (!(err instanceof Aborted) && !(err instanceof DOMException && err.name === 'AbortError')) throw err
        if (gone) {
          // deleted mid-run: a segment may have landed after the delete, so sweep our own rung
          await storage.deletePrefix(hlsKey(videoId, rung.height) + '/')
          if (!(await videos.findOne({ _id: videoId }, { projection: { _id: 1 } }))) await keys.removeVideo(videoId) // a key made after the delete
          return 'skipped'
        }
        // shutting down: hand the job back without using up an attempt
        if (stopping && token) {
          await job.moveToDelayed(Date.now() + 1000, token)
          throw new DelayedError()
        }
        throw err
      } finally {
        active.delete(ctl)
        await rm(dir, { recursive: true, force: true })
      }
    })
  }

  const overall = (v: Pick<VideoDoc, 'renditions'>) => {
    const r = v.renditions ?? []
    const avg = r.length ? r.reduce((s, x) => s + x.progress, 0) / r.length : 0
    return Math.round(PROBE_SHARE + ((100 - PROBE_SHARE) * avg) / 100 - (avg === 100 ? 1 : 0)) // 100 is reserved for ready
  }

  async function saveProgress(id: string, run: number, height: number, percent: number) {
    const v = await videos.findOneAndUpdate(
      { _id: id, run },
      { $max: { 'renditions.$[r].progress': percent } },
      { arrayFilters: [{ 'r.height': height }], returnDocument: 'after' },
    )
    if (v) {
      const progress = overall(v)
      if (progress > v.progress) await videos.updateOne({ _id: id, run }, { $max: { progress } })
      await announce({ ...v, progress: Math.max(progress, v.progress) })
    }
    return v
  }

  async function finalizeJob(job: Job<ProbeData>) {
    const { videoId, run } = job.data
    const v = await current(videoId, run)
    if (!v || v.status !== 'processing') return 'skipped'

    return timed(job, 'finalize', async () => {
      const done = (v.renditions ?? []).filter((r) => r.bandwidth)
      if (!done.length || done.length !== v.renditions?.length) throw new Error('not every rendition finished')
      await storage.put(hlsKey(videoId, 'master.m3u8'), masterPlaylist(done as { height: number; width: number; bandwidth: number }[], v.source?.hasAudio ?? true), 'application/vnd.apple.mpegurl')
      const ready = await videos.findOneAndUpdate(
        { _id: videoId, run, status: 'processing' },
        { $set: { status: 'ready', progress: 100, readyAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (ready) {
        await announce(ready)
        await queueUnderstanding(ready)
      }
      return 'ready'
    })
  }

  // runs after ready, so playback never waits for it
  async function queueUnderstanding(v: VideoDoc) {
    if (!deps.understand?.enabled || !v.source?.hasAudio) return void (await videos.updateOne({ _id: v._id }, { $set: { understanding: 'off' } }))
    try {
      await videos.updateOne({ _id: v._id }, { $set: { understanding: 'pending' } })
      await queues.enqueueUnderstand(v._id, v.run, v.uRun ?? 0)
    } catch (err) {
      await videos.updateOne({ _id: v._id }, { $set: { understanding: 'failed', understandingError: `could not queue transcription: ${message(err)}` } })
    }
  }

  // BullMQ calls these once a job has no attempts left
  async function onFailed(job: Job | undefined, err: Error) {
    if (!job) return
    const finalFailure = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1)
    if (!finalFailure || err instanceof DelayedError) return
    const { videoId, run } = job.data as ProbeData
    if (err instanceof UnrecoverableError && job.name === 'probe') return // already recorded with its own reason
    const what = job.name === 'encode' ? `encoding ${(job.data as EncodeData).rung.height}p failed` : `${job.name} failed`
    await failVideo(videoId, run, `${what}: ${message(err)}`, { retryable: true })
  }

  // temp dirs from a worker that was killed outright
  async function sweepTemp(olderThanMs = 3600_000) {
    await mkdir(config.media.tmpDir, { recursive: true })
    for (const name of await readdir(config.media.tmpDir).catch(() => [] as string[])) {
      if (!name.startsWith(TMP_PREFIX)) continue
      const path = join(config.media.tmpDir, name)
      const { mtimeMs } = await stat(path)
      if (Date.now() - mtimeMs > olderThanMs) await rm(path, { recursive: true, force: true })
    }
  }

  return {
    probeJob,
    encodeJob,
    finalizeJob,
    onFailed,
    sweepTemp,
    // stop ffmpeg now; jobs go back to the queue instead of waiting for a long encode
    stop() {
      stopping = true
      active.forEach((c) => c.abort())
    },
  }
}
