import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { groqAi } from '../apps/api/src/ai.js'
import { config } from '../apps/api/src/config.js'
import { resetLimits } from '../apps/api/src/ratelimit.js'
import { fakeAi } from './fakeAi.js'
import { harness } from './harness.js'

type H = Awaited<ReturnType<typeof harness>>
type Who = Awaited<ReturnType<H['signup']>>
let h: H
let hOff: H
let ai: Awaited<ReturnType<typeof fakeAi>>
let owner: Who
let viewer: Who
let stranger: Who
const V = 'vid'
let summary: () => string | number = () => '{"summary":"This viewer tried a second device several times. Ask them whether they are sharing the login."}'

const post = (who: Who, path: string, json: unknown = {}) => h.call(path, { cookie: who.cookie, json })
const get = (who: Who, path: string) => h.call(path, { cookie: who.cookie })
const event = (who: Who, type: unknown, position: unknown = 0) => post(who, `/api/videos/${V}/events`, { type, position })
const start = async (who: Who, lease?: string) => {
  const res = await post(who, `/api/videos/${V}/playback`, { lease })
  return { status: res.status, body: (await res.json()) as { token: string; lease: string; resume: number } }
}
const stop = (who: Who, lease: string) => post(who, `/api/videos/${V}/playback/stop`, { lease })
const key = (token: string, group: number) => fetch(`${h.api}/api/keys/${V}/${group}`, { headers: { authorization: `Bearer ${token}` } })
const events = (who: Who, type?: string) => h.db.collection('events').find({ video: V, user: who.user.id, ...(type ? { type } : {}) }).toArray()
const flags = async (who: Who) => (await (await get(who, '/api/flags')).json()) as { id: string; rule: string; viewer: string; count: number; summary?: string; text: string; title: string }[]

beforeAll(async () => {
  ai = await fakeAi()
  config.ai.baseUrl = ai.url
  config.ai.key = 'gsk_test'
  ai.script.chat = () => summary()
  h = await harness({ ai: groqAi() })
  hOff = await harness({ ai: null })
  owner = await h.signup('owner@example.com')
  viewer = await h.signup('viewer@example.com')
  stranger = await h.signup('stranger@example.com')
  await h.videoCol.insertOne({ _id: V, owner: owner.user.id, title: 'Course', status: 'ready', size: 1, createdAt: new Date(), viewers: ['viewer@example.com'], rawKey: 'r', run: 1, progress: 100, duration: 600 })
  for (let g = 0; g < 10; g++) await h.keys.getOrCreate(V, g)
})
afterAll(async () => {
  await h.close()
  await hOff.close()
  await ai.close()
})
beforeEach(async () => {
  resetLimits()
  ai.reset()
  summary = () => '{"summary":"This viewer tried a second device several times. Ask them whether they are sharing the login."}'
  h.clock.now += 3 * 3600_000 // each test starts after the last one's windows closed
  for (const c of ['events', 'flags', 'watch']) await h.db.collection(c).deleteMany({})
  await h.lease.release(`${owner.user.id}:${V}`, 'x')
})

describe('resume', () => {
  it('saves where each person stopped and gives it back with the playback token', async () => {
    expect((await event(owner, 'progress', 42.7)).status).toBe(204)
    expect((await event(viewer, 'progress', 300)).status).toBe(204)
    const a = await start(owner)
    expect(a.body.resume).toBe(42)
    await stop(owner, a.body.lease)
    const b = await start(viewer)
    expect(b.body.resume).toBe(300)
    await stop(viewer, b.body.lease)
  })

  it('shows each person their own progress on the library list', async () => {
    await event(viewer, 'progress', 120)
    const mine = (await (await h.call('/api/videos', { cookie: viewer.cookie })).json()) as { id: string; position?: number; completed?: boolean }[]
    expect(mine.find((r) => r.id === V)).toMatchObject({ position: 120, completed: false })
    const other = (await (await h.call('/api/videos', { cookie: owner.cookie })).json()) as { id: string; position?: number }[]
    expect(other.find((r) => r.id === V)!.position).not.toBe(120)
    await event(viewer, 'ended', 600)
    const done = (await (await h.call('/api/videos', { cookie: viewer.cookie })).json()) as { id: string; completed?: boolean }[]
    expect(done.find((r) => r.id === V)!.completed).toBe(true)
  })

  it('starts over after the end, near the start, and when the saved spot is almost the end', async () => {
    for (const [pos, type] of [[5000, 'progress'], [3, 'progress'], [595, 'progress']] as const) {
      await event(owner, type, pos)
      const s = await start(owner)
      expect(s.body.resume).toBe(0)
      await stop(owner, s.body.lease)
    }
    await event(owner, 'progress', 200)
    await event(owner, 'ended', 600)
    const s = await start(owner)
    expect(s.body.resume).toBe(0)
    await stop(owner, s.body.lease)
    const saved = await h.db.collection('watch').findOne({ video: V, user: owner.user.id })
    expect(saved).toMatchObject({ completed: true, position: 0 })
  })

  it('clamps the position to the video length', async () => {
    await event(owner, 'progress', 99999)
    expect((await h.db.collection('watch').findOne({ video: V, user: owner.user.id }))!.position).toBe(600)
  })

  it('refuses strangers, bad types, bad positions and videos that are not ready', async () => {
    expect((await event(stranger, 'progress', 5)).status).toBe(404)
    expect((await event(owner, 'explode', 5)).status).toBe(400)
    expect((await event(owner, 'start', 5)).status).toBe(400) // server-only types cannot be sent by a client
    expect((await event(owner, 'denied', 5)).status).toBe(400)
    for (const bad of [-1, 'x', null, {}]) expect((await event(owner, 'progress', bad)).status).toBe(400)
    expect((await post(owner, `/api/videos/${V}/events`, { type: 'progress' })).status).toBe(400) // no position at all
    expect((await h.call(`/api/videos/${V}/events`, { json: { type: 'progress', position: 1 } })).status).toBe(401)
    await h.videoCol.insertOne({ _id: 'busy', owner: owner.user.id, title: 'b', status: 'processing', size: 1, createdAt: new Date(), viewers: [], rawKey: 'r', run: 1, progress: 5 })
    expect((await post(owner, '/api/videos/busy/events', { type: 'progress', position: 1 })).status).toBe(409)
  })
})

describe('events', () => {
  it('keeps pause, play, seek and ended, but not the progress pings', async () => {
    for (let i = 0; i < 5; i++) await event(owner, 'progress', i * 10)
    expect(await events(owner)).toHaveLength(0)
    await event(owner, 'play', 1)
    await event(owner, 'pause', 20)
    await event(owner, 'seek', 100)
    await event(owner, 'ended', 600)
    expect((await events(owner)).map((e) => e.type)).toEqual(['play', 'pause', 'seek', 'ended'])
  })

  it('limits how many a user can send, and expires old ones', async () => {
    const u = await h.signup('chatty@example.com')
    await h.videoCol.updateOne({ _id: V }, { $addToSet: { viewers: 'chatty@example.com' } })
    let last = 204
    for (let i = 0; i < 121; i++) last = (await event(u, 'progress', 1)).status
    expect(last).toBe(429)
    const idx = await h.db.collection('events').indexes()
    expect(idx.find((i) => i.key.at === 1)?.expireAfterSeconds).toBe(config.eventDays * 86400)
    await h.videoCol.updateOne({ _id: V }, { $pull: { viewers: 'chatty@example.com' } })
  })
})

describe('server side events', () => {
  it('records a fresh start once, not the refreshes, and a refused second device', async () => {
    const a = await start(owner)
    await start(owner, a.body.lease)
    await start(owner, a.body.lease)
    expect(await events(owner, 'start')).toHaveLength(1)
    expect((await start(owner)).status).toBe(409)
    expect(await events(owner, 'denied')).toHaveLength(1)
    await stop(owner, a.body.lease)
  })

  it('records each key request, and marks one far past the last reported position', async () => {
    const a = await start(owner)
    await event(owner, 'progress', 0)
    expect((await key(a.body.token, 0)).status).toBe(200)
    expect((await key(a.body.token, 1)).status).toBe(200) // 30 s ahead: a player buffers that far
    expect((await key(a.body.token, 9)).status).toBe(200) // 270 s ahead
    const keys = await events(owner, 'key')
    expect(keys.map((k) => k.group)).toEqual([0, 1])
    const ahead = await events(owner, 'key_ahead')
    expect(ahead).toHaveLength(1)
    expect(ahead[0]).toMatchObject({ group: 9, gap: 270 })
    await stop(owner, a.body.lease)
  })

  it('does not call a key ahead when the player said it seeked there', async () => {
    const a = await start(owner)
    await event(owner, 'seek', 270)
    await key(a.body.token, 9)
    expect(await events(owner, 'key_ahead')).toHaveLength(0)
    await stop(owner, a.body.lease)
  })
})

describe('flags', () => {
  const deny = async (who: Who, n: number) => {
    const holder = await start(who)
    for (let i = 0; i < n; i++) await start(who)
    return holder.body.lease
  }

  it('raises many_devices at the threshold, for the right viewer, and tells only the owner', async () => {
    const lease = await deny(viewer, config.flags.deviceDenials - 1)
    expect(await flags(owner)).toEqual([])
    await start(viewer)
    const list = await flags(owner)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ rule: 'many_devices', viewer: 'viewer@example.com', count: config.flags.deviceDenials, title: 'Course' })
    expect(list[0]!.text).toMatch(/second device/)
    expect(await flags(viewer)).toEqual([]) // the one being looked at does not see it
    expect(await flags(stranger)).toEqual([])
    await stop(viewer, lease)
  })

  it('keeps one flag per rule and viewer and updates its count', async () => {
    const lease = await deny(viewer, config.flags.deviceDenials + 2)
    const list = await flags(owner)
    expect(list).toHaveLength(1)
    expect(list[0]!.count).toBe(config.flags.deviceDenials + 2)
    await stop(viewer, lease)
  })

  it('lets the owner dismiss it, only the owner, and a dismissed one stays dismissed', async () => {
    const lease = await deny(viewer, config.flags.deviceDenials)
    const [f] = await flags(owner)
    expect((await post(viewer, `/api/flags/${encodeURIComponent(f!.id)}/dismiss`)).status).toBe(404)
    expect((await post(stranger, `/api/flags/${encodeURIComponent(f!.id)}/dismiss`)).status).toBe(404)
    expect((await post(owner, `/api/flags/${encodeURIComponent(f!.id)}/dismiss`)).status).toBe(204)
    expect(await flags(owner)).toEqual([])
    await start(viewer)
    await start(viewer)
    expect(await flags(owner)).toEqual([])
    await stop(viewer, lease)
  })

  it('raises repeat_replays after many fresh starts', async () => {
    for (let i = 0; i < config.flags.replayStarts; i++) {
      const s = await start(viewer)
      await stop(viewer, s.body.lease)
    }
    expect((await flags(owner)).map((f) => f.rule)).toEqual(['repeat_replays'])
  })

  it('raises key_ahead for a client that never reports where it is and asks for keys down the video', async () => {
    const a = await start(viewer)
    for (const g of [5, 6, 7]) await key(a.body.token, g)
    expect((await flags(owner)).map((f) => f.rule)).toEqual(['key_ahead'])
    await stop(viewer, a.body.lease)
  })

  it('raises key_burst for a flood of key requests', async () => {
    const a = await start(viewer)
    await event(viewer, 'progress', 0)
    for (let i = 0; i < config.flags.burstKeys; i++) await key(a.body.token, 0)
    expect((await flags(owner)).map((f) => f.rule)).toContain('key_burst')
    await stop(viewer, a.body.lease)
  })

  it('raises nothing for an ordinary viewing session', async () => {
    const a = await start(viewer)
    await event(viewer, 'play', 0)
    for (let g = 0; g < 4; g++) {
      await event(viewer, 'progress', g * 30)
      await key(a.body.token, g)
      h.clock.now += 30_000
    }
    await event(viewer, 'pause', 100)
    await event(viewer, 'seek', 400)
    await key(a.body.token, 13 > 9 ? 9 : 13) // 270 s, but the player just said it seeked past it
    await event(viewer, 'ended', 600)
    await stop(viewer, a.body.lease)
    await h.analytics.settle()
    expect(await flags(owner)).toEqual([])
  })
})

describe('summary', () => {
  const trip = async () => {
    const holder = await start(viewer)
    for (let i = 0; i < config.flags.deviceDenials; i++) await start(viewer)
    await h.analytics.settle()
    return holder.body.lease
  }

  it('is written by the model from structured facts only', async () => {
    const lease = await trip()
    const [f] = await flags(owner)
    expect(f!.summary).toMatch(/second device/)
    const call = ai.calls.find((c) => c.path === '/chat/completions')!
    const [system, user] = call.json.messages as { content: string }[]
    expect(system!.content).toContain('Use only the facts in the JSON')
    const facts = JSON.parse(user!.content)
    expect(facts).toMatchObject({ rule: 'many_devices', timesSeen: config.flags.deviceDenials, withinMinutes: config.flags.deviceWindowMin, videoLengthMinutes: 10 })
    expect(user!.content).not.toContain('viewer@example.com') // no address goes to the model
    expect(user!.content).not.toContain(viewer.user.id)
    await stop(viewer, lease)
  })

  it('is left out when the model fails or answers with junk, and the flag still shows its rule', async () => {
    for (const bad of [500, 'not json at all', '{"summary":""}', '{"summary":42}']) {
      await h.db.collection('flags').deleteMany({})
      await h.db.collection('events').deleteMany({})
      h.clock.now += 3 * 3600_000
      summary = () => bad
      const lease = await trip()
      const [f] = await flags(owner)
      expect(f!.summary).toBeUndefined()
      expect(f!.text).toBeTruthy()
      await stop(viewer, lease)
    }
  })

  it('does not ask again inside the cooldown after a failure', async () => {
    summary = () => 500
    const lease = await trip()
    const first = ai.calls.length
    await start(viewer)
    await h.analytics.settle()
    expect(ai.calls.length).toBe(first)
    h.clock.now += (config.flags.summaryCooldownMin + 1) * 60_000
    summary = () => '{"summary":"Second try worked."}'
    await h.db.collection('events').insertMany(Array.from({ length: 3 }, () => ({ video: V, user: viewer.user.id, type: 'denied', at: new Date(h.clock.now) })))
    await start(viewer) // triggers detection again
    await h.analytics.settle()
    expect((await flags(owner))[0]!.summary).toBe('Second try worked.')
    await stop(viewer, lease)
  })

  it('does nothing without a provider', async () => {
    const o = await hOff.signup('o2@example.com')
    const v = await hOff.signup('v2@example.com')
    await hOff.videoCol.insertOne({ _id: V, owner: o.user.id, title: 'T', status: 'ready', size: 1, createdAt: new Date(), viewers: ['v2@example.com'], rawKey: 'r', run: 1, progress: 100, duration: 600 })
    const first = await hOff.call(`/api/videos/${V}/playback`, { cookie: v.cookie, json: {} })
    expect(first.status).toBe(200)
    for (let i = 0; i < config.flags.deviceDenials; i++) await hOff.call(`/api/videos/${V}/playback`, { cookie: v.cookie, json: {} })
    const list = (await (await hOff.call('/api/flags', { cookie: o.cookie })).json()) as { summary?: string; rule: string }[]
    expect(list).toHaveLength(1)
    expect(list[0]!.summary).toBeUndefined()
  })
})

describe('owner overview', () => {
  it('counts starts, watchers and completions without naming anyone, and is for the owner only', async () => {
    const a = await start(viewer)
    await event(viewer, 'progress', 120)
    await stop(viewer, a.body.lease)
    const b = await start(owner)
    await event(owner, 'ended', 600)
    await stop(owner, b.body.lease)
    const res = await get(owner, `/api/videos/${V}/analytics`)
    const body = (await res.json()) as { starts: number; watchers: number; completed: number; recent: Record<string, unknown>[] }
    expect(body).toMatchObject({ starts: 2, watchers: 2, completed: 1 })
    expect(JSON.stringify(body)).not.toContain('@')
    expect(body.recent.find((r) => r.position === 120)).toMatchObject({ completed: false, starts: 1, you: false })
    expect((await get(viewer, `/api/videos/${V}/analytics`)).status).toBe(403)
    expect((await get(stranger, `/api/videos/${V}/analytics`)).status).toBe(404)
  })
})

describe('delete', () => {
  it('removes watch positions, events and flags', async () => {
    const o = await h.signup('del@example.com')
    await h.videoCol.insertOne({ _id: 'gone', owner: o.user.id, title: 'g', status: 'ready', size: 1, createdAt: new Date(), viewers: [], rawKey: 'r', run: 1, progress: 100, duration: 100 })
    await post(o, '/api/videos/gone/events', { type: 'pause', position: 5 })
    await h.db.collection<{ _id: string; video: string; owner: string }>('flags').insertOne({ _id: 'gone:x:key_burst', video: 'gone', owner: o.user.id })
    expect((await h.call('/api/videos/gone', { cookie: o.cookie, method: 'DELETE' })).status).toBe(204)
    for (const c of ['events', 'watch', 'flags']) expect(await h.db.collection(c).countDocuments({ video: 'gone' })).toBe(0)
  })
})
