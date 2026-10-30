import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { groqAi } from '../apps/api/src/ai.js'
import { config } from '../apps/api/src/config.js'
import { fakeAi } from '../test/fakeAi.js'
import { decodeCheck, makeSource, makeStack, until, type Stack } from './stack.js'

let s: Stack
let ai: Awaited<ReturnType<typeof fakeAi>>
let alice: Awaited<ReturnType<Stack['signup']>>
let bob: Awaited<ReturnType<Stack['signup']>>
let id: string
const src = join(process.env.TMP_DIR!, 'analytics-src.mp4')
const was = { ...config.flags }

const post = (who: { cookie: string }, path: string, json: unknown = {}) => s.call(path, { cookie: who.cookie, json })
const start = async (who: { cookie: string }, lease?: string) => {
  const res = await post(who, `/api/videos/${id}/playback`, { lease })
  return { status: res.status, body: (await res.json()) as { token: string; lease: string; resume: number } }
}
const stop = (who: { cookie: string }, lease: string) => post(who, `/api/videos/${id}/playback/stop`, { lease })
const key = (token: string, g: number) => fetch(`${s.api}/api/keys/${id}/${g}`, { headers: { authorization: `Bearer ${token}` } })
const flags = async () => (await (await s.call('/api/flags', { cookie: alice.cookie })).json()) as { rule: string; viewer: string; count: number; summary?: string }[]

beforeAll(async () => {
  await mkdir(process.env.TMP_DIR!, { recursive: true })
  await makeSource(src, { seconds: 24, size: '640x360' })
  config.hls.segmentsPerKey = 1 // 4 key groups of 6 s
  ai = await fakeAi()
  Object.assign(config.ai, { baseUrl: ai.url, key: 'gsk_test', attempts: 2, backoffMs: 200 })
  ai.script.transcribe = () => []
  ai.script.chat = (m) => (m[0]!.content.startsWith('You write a short note') ? '{"summary":"Looks like the login is being shared. Ask the viewer."}' : '{}')
  s = await makeStack({ ai: groqAi() })
  alice = await s.signup('alice@example.com')
  bob = await s.signup('bob@example.com')
  id = (await s.send(alice, src, 'course.mp4')).id
  await s.waitFor(id, 'ready')
  await post(alice, `/api/videos/${id}/viewers`, { email: 'bob@example.com' })
})
afterAll(async () => {
  Object.assign(config.flags, was)
  config.hls.segmentsPerKey = 5
  await s.close()
  await ai.close()
})

describe('on real storage, Redis and Mongo', () => {
  it('a normal player-like client (ffmpeg) raises nothing, and its start and keys are recorded', async () => {
    await decodeCheck(s, alice, id)
    expect(await flags()).toEqual([])
    const types = (await s.db.collection('events').find({ video: id }).toArray()).map((e) => e.type)
    expect(types.filter((t) => t === 'start')).toHaveLength(1)
    expect(types.filter((t) => t === 'key' || t === 'key_ahead').length).toBeGreaterThanOrEqual(3)
  })

  it('resume survives the whole trip', async () => {
    expect((await post(bob, `/api/videos/${id}/events`, { type: 'progress', position: 9.4 })).status).toBe(204)
    const a = await start(bob)
    expect(a.body.resume).toBe(9)
    await stop(bob, a.body.lease)
  })

  it('flags a viewer who replays, uses a second device and scrapes keys, and the owner sees all three with summaries', async () => {
    Object.assign(config.flags, { replayStarts: 3, deviceDenials: 2, aheadSeconds: 5, aheadCount: 2 })

    for (let i = 0; i < 3; i++) await stop(bob, (await start(bob)).body.lease) // replays

    const holder = await start(bob) // second device
    expect((await start(bob)).status).toBe(409)
    expect((await start(bob)).status).toBe(409)

    // a script holding a valid token takes the keys down the video; its last reported position is the very start
    await post(bob, `/api/videos/${id}/events`, { type: 'progress', position: 0 })
    for (const g of [0, 1, 2]) expect((await key(holder.body.token, g)).status).toBe(200)
    await stop(bob, holder.body.lease)

    const list = await until(async () => {
      const l = await flags()
      return l.length === 3 && l.every((f) => f.summary) ? l : undefined
    }, 20_000)
    expect(list.map((f) => f.rule).sort()).toEqual(['key_ahead', 'many_devices', 'repeat_replays'])
    expect(list.every((f) => f.viewer === 'bob@example.com')).toBe(true)
    expect((await s.call('/api/flags', { cookie: bob.cookie }).then((r) => r.json())) as unknown[]).toEqual([])
    const prompt = ai.calls.filter((c) => c.path === '/chat/completions' && c.json.messages[0].content.startsWith('You write')).map((c) => c.json.messages[1].content as string).join('')
    expect(prompt).not.toContain('bob@example.com')
  })

  it('shows the owner counts, and delete clears everything', async () => {
    const o = (await (await s.call(`/api/videos/${id}/analytics`, { cookie: alice.cookie })).json()) as { starts: number; watchers: number }
    expect(o.starts).toBeGreaterThanOrEqual(5)
    expect(o.watchers).toBe(1) // bob reported a position; the ffmpeg run reported none
    expect((await s.call(`/api/videos/${id}`, { cookie: alice.cookie, method: 'DELETE' })).status).toBe(204)
    for (const c of ['events', 'watch', 'flags']) expect(await s.db.collection(c).countDocuments({ video: id })).toBe(0)
  })
})
