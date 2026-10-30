import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../apps/api/src/config.js'
import { redisLease } from '../apps/api/src/lease.js'
import { decodeCheck, makeSource, makeStack, sleep, type Stack } from './stack.js'

const sh = promisify(execFile)
let s: Stack
let alice: Awaited<ReturnType<Stack['signup']>>
let bob: Awaited<ReturnType<Stack['signup']>>
let id: string
const src = join(process.env.TMP_DIR!, 'play-src.mp4')

beforeAll(async () => {
  await mkdir(process.env.TMP_DIR!, { recursive: true })
  await makeSource(src, { seconds: 14, size: '640x360' }) // 3 segments
  config.hls.segmentsPerKey = 1 // so the rotation shows up in a short clip
  s = await makeStack()
  alice = await s.signup('alice@example.com')
  bob = await s.signup('bob@example.com')
  id = (await s.send(alice, src, 'talk.mp4')).id
  await s.waitFor(id, 'ready')
})
afterAll(async () => {
  config.hls.segmentsPerKey = 5
  await s.close()
})

const start = (who: { cookie: string }, lease?: string) => s.call(`/api/videos/${id}/playback`, { cookie: who.cookie, json: { lease } })
const keyReq = (token: string, group: number) => fetch(`${s.api}/api/keys/${id}/${group}`, { headers: { authorization: `Bearer ${token}` } })

describe('rotating keys on real storage', () => {
  it('a viewer token plays the whole video through the API, fetching a new key for each group', async () => {
    await s.call(`/api/videos/${id}/viewers`, { cookie: alice.cookie, json: { email: 'bob@example.com' } })
    for (const who of [alice, bob]) {
      const out = await decodeCheck(s, who, id)
      expect(out.duration).toBeGreaterThan(13.5)
      expect(out.duration).toBeLessThan(14.8)
      expect([...new Set(out.keyOpens)].sort()).toEqual([0, 1, 2])
    }
    expect(await s.keyCol.countDocuments({ videoId: id })).toBe(3)
  })

  it('stores a different key per group, and the playlists point at the key route', async () => {
    const keys = (await s.keyCol.find({ videoId: id }).toArray()).map((d) => Buffer.from((d.key as { buffer: Uint8Array }).buffer).toString('hex'))
    expect(new Set(keys).size).toBe(3)
    const dir = await s.download(id)
    const { readFile } = await import('node:fs/promises')
    const playlist = await readFile(join(dir, '360', 'index.m3u8'), 'utf8')
    expect([...playlist.matchAll(/URI="(\/api\/keys\/[\w-]+\/\d)"/g)].map((m) => m[1]!.slice(-1))).toEqual(['0', '1', '2'])
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })

  it('ffmpeg cannot play it without a token, with a stranger token, or after access is withdrawn', async () => {
    const url = `${s.api}/media/${id}/master.m3u8`
    await expect(sh('ffmpeg', ['-v', 'error', '-i', url, '-f', 'null', '-'])).rejects.toThrow()

    const carol = await s.signup('carol@example.com')
    expect((await start(carol)).status).toBe(404)

    const { token, lease } = (await (await start(bob)).json()) as { token: string; lease: string }
    expect((await keyReq(token, 0)).status).toBe(200)
    await s.call(`/api/videos/${id}/viewers/bob@example.com`, { cookie: alice.cookie, method: 'DELETE' })
    expect((await keyReq(token, 0)).status).toBe(403)
    await s.call(`/api/videos/${id}/playback/stop`, { cookie: bob.cookie, json: { lease } })
  })
})

describe('device lease on real Redis', () => {
  it('second device refused, first refreshes, slot frees on stop', async () => {
    const a = (await (await start(alice)).json()) as { lease: string }
    expect((await start(alice)).status).toBe(409)
    expect(((await (await start(alice, a.lease)).json()) as { lease: string }).lease).toBe(a.lease)
    await s.call(`/api/videos/${id}/playback/stop`, { cookie: alice.cookie, json: { lease: a.lease } })
    const b = await start(alice)
    expect(b.status).toBe(200)
    await s.call(`/api/videos/${id}/playback/stop`, { cookie: alice.cookie, json: { lease: ((await b.json()) as { lease: string }).lease } })
  })

  it('lapses by itself after its TTL, so a closed tab does not lock the user out', async () => {
    const lease = redisLease(s.leaseRedis, s.leasePrefix)
    const first = (await lease.acquire('ttl-test', 1))!
    expect(await lease.acquire('ttl-test', 1)).toBeNull()
    expect(await lease.hold('ttl-test', 'someone else', 1)).toBe(false)
    expect(await lease.hold('ttl-test', first, 1)).toBe(true)
    await lease.release('ttl-test', 'someone else') // not the holder
    expect(await lease.acquire('ttl-test', 1)).toBeNull()
    await sleep(1300)
    const second = await lease.acquire('ttl-test', 1)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    await lease.release('ttl-test', second!)
    expect(await lease.acquire('ttl-test', 1)).not.toBeNull()
  })

  it('a heartbeat from the key route keeps the slot alive, and a lapsed one loses it', async () => {
    const old = config.playback.leaseSeconds
    config.playback.leaseSeconds = 2
    try {
      const t = (await (await start(alice)).json()) as { token: string; lease: string }
      for (let i = 0; i < 3; i++) {
        await sleep(1000)
        expect((await keyReq(t.token, 0)).status).toBe(200) // each key request refreshes the slot
      }
      expect((await start(alice)).status).toBe(409) // still held after 3 s with a 2 s TTL
      await sleep(2500)
      expect((await keyReq(t.token, 0)).status).toBe(403) // lapsed
      const next = await start(alice)
      expect(next.status).toBe(200)
      await s.call(`/api/videos/${id}/playback/stop`, { cookie: alice.cookie, json: { lease: ((await next.json()) as { lease: string }).lease } })
    } finally {
      config.playback.leaseSeconds = old
    }
  })
})

describe('delete', () => {
  it('removes the keys with the video', async () => {
    expect((await s.call(`/api/videos/${id}`, { cookie: alice.cookie, method: 'DELETE' })).status).toBe(204)
    expect(await s.keyCol.countDocuments({ videoId: id })).toBe(0)
    expect(await s.keys(`hls/${id}/`)).toEqual([])
  })
})
