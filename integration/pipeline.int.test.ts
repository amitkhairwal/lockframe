import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../apps/api/src/config.js'
import { decodeCheck, makeSource, makeStack, type Stack, until } from './stack.js'

let s: Stack
let alice: Awaited<ReturnType<Stack['signup']>>
const src = join(process.env.TMP_DIR!, 'src-720.mp4')

beforeAll(async () => {
  await mkdir(process.env.TMP_DIR!, { recursive: true })
  await makeSource(src, { seconds: 14, size: '1280x720' })
  s = await makeStack()
  alice = await s.signup('alice@example.com')
})
afterAll(async () => {
  await s.close()
  await rm(process.env.TMP_DIR!, { recursive: true, force: true })
})

const tempLeft = async () => (await readdir(config.media.tmpDir)).filter((n) => n.startsWith('sv-'))

const sh = promisify(execFile)

describe('happy path', () => {
  it('goes from upload to a ready HLS ladder that decodes end to end', async () => {
    const { id } = await s.send(alice, src, 'lecture.mp4')
    const v = await s.waitFor(id, 'ready')

    expect(v.progress).toBe(100)
    expect(v.renditions!.map((r) => r.height)).toEqual([720, 480, 360])
    for (const r of v.renditions!) expect(r).toMatchObject({ progress: 100 })
    expect(v.renditions!.every((r) => r.bandwidth && r.segments === 3 && r.bytes)).toBe(true)
    expect(Object.keys(v.timings!).sort()).toEqual(['encode_360', 'encode_480', 'encode_720', 'finalize', 'probe'])
    expect(v.source).toMatchObject({ width: 1280, height: 720, hasAudio: true })

    const out = await decodeCheck(s, alice, id)
    expect(out.duration).toBeGreaterThan(13.5)
    expect(out.duration).toBeLessThan(14.8)
    for (const h of [720, 480, 360]) expect(out.master).toContain(`${h}/index.m3u8`)
    expect(out.master).toContain('RESOLUTION=1280x720')

    // every rung has exactly its three segments plus the playlist, nothing duplicated
    const keys = await s.keys(`hls/${id}/720/`)
    expect(keys.map((k) => k.split('/').pop())).toEqual(['index.m3u8', 'seg_00000.ts', 'seg_00001.ts', 'seg_00002.ts'])
    expect(await tempLeft()).toEqual([])
  })

  it('stores only encrypted output: a key tag in every playlist, segments that are not video, no key in the bucket', async () => {
    const id = (await s.videoCol.findOne({ status: 'ready' }))!._id
    const dir = await s.download(id)
    for (const h of [720, 480, 360]) {
      const playlist = await readFile(join(dir, String(h), 'index.m3u8'), 'utf8')
      expect(playlist.match(/#EXT-X-KEY:METHOD=AES-128,URI="\/api\/keys\/[\w-]+\/0"/g)).toHaveLength(1) // 3 segments, one group
      for (const n of ['seg_00000.ts', 'seg_00001.ts', 'seg_00002.ts']) {
        const bytes = await readFile(join(dir, String(h), n))
        expect(bytes[0]).not.toBe(0x47)
        expect(bytes.length % 16).toBe(0)
        await expect(sh('ffprobe', ['-v', 'error', '-show_streams', join(dir, String(h), n)])).rejects.toThrow()
      }
    }
    // the keys live in Mongo only: no object in storage is a bare 16 byte key
    const all = await s.keys('')
    expect(all.filter((k) => k.startsWith(`hls/${id}/`) && /key/i.test(k))).toEqual([])
    const keyBytes = (await s.keyCol.find({ videoId: id }).toArray()).map((d) => Buffer.from((d.key as { buffer: Uint8Array }).buffer))
    expect(keyBytes).toHaveLength(1)
    for (const k of all.filter((x) => x.startsWith(`hls/${id}/`) && x.endsWith('.ts'))) {
      const body = await readFile(join(dir, k.slice(`hls/${id}/`.length)))
      expect(body.includes(keyBytes[0]!)).toBe(false)
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the same video through the API', async () => {
    const list = (await (await s.call('/api/videos', { cookie: alice.cookie })).json()) as { status: string; heights: number[]; progress: number }[]
    expect(list[0]).toMatchObject({ status: 'ready', heights: [720, 480, 360], progress: 100 })
  })
})

describe('not a video', () => {
  it('fails with a readable reason, drops the raw file, and is not retried', async () => {
    const { writeFile } = await import('node:fs/promises')
    const fake = join(process.env.TMP_DIR!, 'notes.mp4')
    await writeFile(fake, 'this is just some text pretending to be a video '.repeat(2000))
    const { id } = await s.send(alice, fake, 'notes.mp4')

    const v = await until(async () => (await s.videoCol.findOne({ _id: id }))?.status === 'failed' && (await s.videoCol.findOne({ _id: id })))
    expect(v.failure).toMatch(/could not be read as a video|no video stream/)
    expect(v.retryable).toBe(false)
    expect(await s.keys(`raw/${id}/`)).toEqual([])
    expect(await s.keys(`hls/${id}/`)).toEqual([])

    const job = await s.queues.probe.getJob(`probe-${id}-1`)
    expect(job?.attemptsMade).toBe(1)

    const retry = await s.call(`/api/videos/${id}/retry`, { cookie: alice.cookie, method: 'POST' })
    expect(retry.status).toBe(409)
    expect(await tempLeft()).toEqual([])
  })

  it('refuses audio only files', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const wav = join(process.env.TMP_DIR!, 'song.mp4')
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-f', 'mp4', wav])
    const { id } = await s.send(alice, wav, 'song.mp4')
    const v = await until(async () => (await s.videoCol.findOne({ _id: id, status: 'failed' })) ?? undefined)
    expect(v.failure).toMatch(/no video stream/)
  })
})
