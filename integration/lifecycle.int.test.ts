import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../apps/api/src/config.js'
import { makeSource, makeStack, sleep, type Stack, until } from './stack.js'

let s: Stack
let alice: Awaited<ReturnType<Stack['signup']>>
let bob: Awaited<ReturnType<Stack['signup']>>
const dir = process.env.TMP_DIR!
const small = join(dir, 'small.mp4')
const big = join(dir, 'big.mp4')

beforeAll(async () => {
  await mkdir(dir, { recursive: true })
  await makeSource(small, { seconds: 6, size: '1280x720' })
  await makeSource(big, { seconds: 40, size: '1920x1080' })
  s = await makeStack()
  ;[alice, bob] = await Promise.all([s.signup('alice@example.com'), s.signup('bob@example.com')])
})
afterAll(async () => {
  await s.close()
  await rm(dir, { recursive: true, force: true })
})

const tempLeft = async () => (await readdir(config.media.tmpDir)).filter((n) => n.startsWith('sv-'))
const encoding = (id: string) =>
  until(async () => {
    const v = await s.videoCol.findOne({ _id: id })
    return v?.status === 'processing' && v.renditions?.some((r) => r.progress > 0 && r.progress < 100) ? v : undefined
  })

describe('permanent failure and retry', () => {
  let id: string
  const real = config.media.ffmpeg

  it('retries, then ends failed, cleans partial output and leaves no job hanging', async () => {
    config.media.ffmpeg = '/bin/false'
    try {
      id = (await s.send(alice, small, 'doomed.mp4')).id
      const v = await until(async () => (await s.videoCol.findOne({ _id: id, status: 'failed' })) ?? undefined, 60_000)
      expect(v.failure).toMatch(/^encoding \d+p failed: ffmpeg exited 1/)
      expect(v.retryable).toBe(true)
      expect(await s.keys(`hls/${id}/`)).toEqual([])
      expect(await s.keyCol.countDocuments({ videoId: id })).toBe(0)

      const failed = (await s.queues.encode.getJobs(['failed'])).filter((j) => j.data.videoId === id)
      expect(failed.length).toBeGreaterThan(0)
      expect(failed.every((j) => j.attemptsMade === config.worker.attempts)).toBe(true) // retried before giving up
      await until(async () => (await s.queues.finalize.getJobCounts('waiting-children'))['waiting-children'] === 0 || undefined, 20_000)
      expect(await tempLeft()).toEqual([])
    } finally {
      config.media.ffmpeg = real
    }
  })

  it('does not leak the presigned url into the failure text', async () => {
    const v = await s.videoCol.findOne({ _id: id })
    expect(v!.failure).not.toMatch(/X-Amz-Signature|devkey/i)
  })

  it('lets the owner retry it to ready, and nobody else', async () => {
    expect((await s.call(`/api/videos/${id}/retry`, { cookie: bob.cookie, method: 'POST' })).status).toBe(404)
    const res = await s.call(`/api/videos/${id}/retry`, { cookie: alice.cookie, method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'uploaded' })
    const v = await s.waitFor(id, 'ready')
    expect(v.run).toBe(2)
    expect(v.failure).toBeUndefined()
    expect((await s.keys(`hls/${id}/`)).length).toBeGreaterThan(3)
  })

  it('refuses to retry a video that is not failed', async () => {
    expect((await s.call(`/api/videos/${id}/retry`, { cookie: alice.cookie, method: 'POST' })).status).toBe(409)
  })
})

describe('delete while processing', () => {
  it('stops the work, leaves no output, and the worker keeps going', async () => {
    const { id } = await s.send(alice, big, 'long.mp4')
    await encoding(id)
    expect((await s.call(`/api/videos/${id}`, { cookie: alice.cookie, method: 'DELETE' })).status).toBe(204)

    await until(async () => (await s.queues.encode.getJobCounts('active')).active === 0 || undefined, 60_000)
    await sleep(1500)
    expect(await s.videoCol.countDocuments({ _id: id })).toBe(0)
    expect(await s.keys(`hls/${id}/`)).toEqual([])
    expect(await s.keys(`raw/${id}/`)).toEqual([])
    expect(await s.keyCol.countDocuments({ videoId: id })).toBe(0)
    expect(await tempLeft()).toEqual([])

    const next = await s.send(alice, small, 'after.mp4')
    await s.waitFor(next.id, 'ready')
  })
})

describe('graceful shutdown', () => {
  it('hands a running encode back to the queue, cleans up, and the next worker finishes it', async () => {
    const { id } = await s.send(alice, big, 'interrupted.mp4')
    await encoding(id)

    await s.stopWorkers()
    expect(await tempLeft()).toEqual([])
    // only this video's jobs: earlier tests leave failed jobs in the same queue
    const mine = (await s.queues.encode.getJobs(['failed', 'delayed', 'waiting', 'active'])).filter((j) => j.data.videoId === id)
    const states = await Promise.all(mine.map((j) => j.getState()))
    expect(states).not.toContain('failed')
    expect(states).not.toContain('active')
    expect(states.some((st) => st === 'delayed' || st === 'waiting')).toBe(true)
    expect((await s.videoCol.findOne({ _id: id }))!.status).toBe('processing')

    await s.startWorkers()
    const v = await s.waitFor(id, 'ready', 180_000)
    expect(v.renditions!.map((r) => r.height)).toEqual([1080, 720, 480, 360])
    expect(await tempLeft()).toEqual([])
  })
})

describe('live progress over Socket.io', () => {
  const open = (cookie?: string) =>
    new Promise<Socket>((resolve, reject) => {
      const sock = connect(s.api, { extraHeaders: cookie ? { cookie } : {}, transports: ['websocket'], reconnection: false })
      sock.on('connect', () => resolve(sock))
      sock.on('connect_error', reject)
    })

  it('needs a session to connect', async () => {
    await expect(open()).rejects.toThrow(/login required/)
    await expect(open('sv_session=garbage')).rejects.toThrow(/login required/)
  })

  it('sends the owner steady progress that ends in ready, and sends strangers nothing', async () => {
    const [a, b] = await Promise.all([open(alice.cookie), open(bob.cookie)])
    const mine: { id: string; status: string; progress: number }[] = []
    const theirs: unknown[] = []
    a.on('video', (e) => mine.push(e))
    b.on('video', (e) => theirs.push(e))

    const { id } = await s.send(alice, small, 'live.mp4')
    await s.waitFor(id, 'ready')
    await until(async () => mine.at(-1)?.status === 'ready' || undefined, 10_000)

    expect(mine.every((e) => e.id === id)).toBe(true)
    expect(mine.length).toBeGreaterThan(2)
    for (let i = 1; i < mine.length; i++) expect(mine[i]!.progress).toBeGreaterThanOrEqual(mine[i - 1]!.progress)
    expect(mine.at(-1)).toMatchObject({ status: 'ready', progress: 100 })
    expect(mine.some((e) => e.status === 'processing')).toBe(true)
    expect(theirs).toEqual([])
    const thumb = await s.call(`/api/videos/${id}/thumb`, { cookie: alice.cookie })
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await thumb.arrayBuffer()).subarray(0, 2).toString('hex')).toBe('ffd8') // a real jpeg
    expect((await s.keys('hls/')).some((k) => k.includes('thumb'))).toBe(false) // never next to the public media
    expect(JSON.stringify(mine)).not.toContain('owner')
    a.close()
    b.close()
  })
})
