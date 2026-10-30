import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../apps/api/src/config.js'
import { memoryLease } from '../apps/api/src/lease.js'
import { harness } from './harness.js'

type H = Awaited<ReturnType<typeof harness>>
let h: H
let owner: Awaited<ReturnType<H['signup']>>
let viewer: Awaited<ReturnType<H['signup']>>
let stranger: Awaited<ReturnType<H['signup']>>
const VIDEO = 'vid-1'

const play = (who: { cookie: string }, id = VIDEO, lease?: string) => h.call(`/api/videos/${id}/playback`, { cookie: who.cookie, json: { lease } })
const keyReq = (token: string | undefined, id = VIDEO, group = 0) =>
  fetch(`${h.api}/api/keys/${id}/${group}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
const tokenOf = async (who: { cookie: string }) => ((await (await play(who)).json()) as { token: string; lease: string })

beforeAll(async () => {
  h = await harness()
  owner = await h.signup('owner@example.com')
  viewer = await h.signup('viewer@example.com')
  stranger = await h.signup('stranger@example.com')
  await h.videoCol.insertOne({ _id: VIDEO, owner: owner.user.id, title: 'v', status: 'ready', size: 1, createdAt: new Date(), viewers: ['viewer@example.com'], rawKey: 'raw/x', run: 1, progress: 100, duration: 30 })
  await h.keys.getOrCreate(VIDEO, 0)
})
afterAll(() => h.close())

describe('playback token', () => {
  it('goes to the owner and to an invited viewer, and carries the viewer email for the watermark', async () => {
    const res = await play(owner)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ viewer: 'owner@example.com', master: `/media/${VIDEO}/master.m3u8`, expiresIn: 120 })
    expect(typeof body.token).toBe('string')
    await h.lease.release(`${owner.user.id}:${VIDEO}`, body.lease as string)
    const v = await play(viewer)
    expect(v.status).toBe(200)
    await h.lease.release(`${viewer.user.id}:${VIDEO}`, ((await v.json()) as { lease: string }).lease)
  })

  it('is refused without a login, for a stranger (404 like a missing video), and for a video that is not ready', async () => {
    expect((await h.call(`/api/videos/${VIDEO}/playback`, { json: {} })).status).toBe(401)
    expect((await play(stranger)).status).toBe(404)
    expect((await play(owner, 'nope')).status).toBe(404)
    await h.videoCol.insertOne({ _id: 'busy', owner: owner.user.id, title: 'b', status: 'processing', size: 1, createdAt: new Date(), viewers: [], rawKey: 'r', run: 1, progress: 10 })
    expect((await play(owner, 'busy')).status).toBe(409)
  })
})

describe('key route', () => {
  it('serves 16 bytes to the right viewer, never cached', async () => {
    const { token, lease } = await tokenOf(owner)
    const res = await keyReq(token)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const key = Buffer.from(await res.arrayBuffer())
    expect(key).toHaveLength(16)
    expect(key.equals((await h.keys.get(VIDEO, 0))!)).toBe(true)
    await h.lease.release(`${owner.user.id}:${VIDEO}`, lease)
  })

  it('refuses: no token, cookie only, garbage, a session cookie used as a token', async () => {
    expect((await keyReq(undefined)).status).toBe(401)
    expect((await fetch(`${h.api}/api/keys/${VIDEO}/0`, { headers: { cookie: owner.cookie } })).status).toBe(401)
    expect((await keyReq('garbage')).status).toBe(401)
    expect((await keyReq(owner.cookie.split('=')[1])).status).toBe(401) // right secret, wrong audience
  })

  it('refuses an expired token, and a token for another video', async () => {
    const sign = (claims: object, exp: string) =>
      new SignJWT(claims as Record<string, unknown>).setProtectedHeader({ alg: 'HS256' }).setAudience('playback').setIssuedAt().setExpirationTime(exp).sign(new TextEncoder().encode(config.sessionSecret))
    const claims = { user: owner.user.id, email: 'owner@example.com', video: VIDEO, lease: 'x' }
    expect((await keyReq(await sign(claims, '-10s'))).status).toBe(401)

    await h.videoCol.insertOne({ _id: 'other', owner: owner.user.id, title: 'o', status: 'ready', size: 1, createdAt: new Date(), viewers: [], rawKey: 'r', run: 1, progress: 100 })
    await h.keys.getOrCreate('other', 0)
    const { token, lease } = await tokenOf(owner)
    expect((await keyReq(token, 'other')).status).toBe(403)
    await h.lease.release(`${owner.user.id}:${VIDEO}`, lease)
  })

  it('refuses a viewer whose access was withdrawn while the token was still alive', async () => {
    const { token, lease } = await tokenOf(viewer)
    expect((await keyReq(token)).status).toBe(200)
    await h.videoCol.updateOne({ _id: VIDEO }, { $pull: { viewers: 'viewer@example.com' } })
    expect((await keyReq(token)).status).toBe(403)
    await h.videoCol.updateOne({ _id: VIDEO }, { $addToSet: { viewers: 'viewer@example.com' } })
    await h.lease.release(`${viewer.user.id}:${VIDEO}`, lease)
  })

  it('refuses a key that does not exist, and a bad number', async () => {
    const { token, lease } = await tokenOf(owner)
    expect((await keyReq(token, VIDEO, 99)).status).toBe(404)
    expect((await keyReq(token, VIDEO, -1)).status).toBe(400)
    expect((await fetch(`${h.api}/api/keys/${VIDEO}/abc`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(400)
    await h.lease.release(`${owner.user.id}:${VIDEO}`, lease)
  })
})

describe('one device at a time', () => {
  it('refuses a second device, lets the first refresh, and frees the slot on stop', async () => {
    const first = (await (await play(owner)).json()) as { lease: string; token: string }
    const second = await play(owner) // a different browser has no lease id
    expect(second.status).toBe(409)

    const again = await play(owner, VIDEO, first.lease) // the first one refreshing before the token runs out
    expect(again.status).toBe(200)
    expect(((await again.json()) as { lease: string }).lease).toBe(first.lease)

    expect((await play(owner, VIDEO, 'guess')).status).toBe(409) // guessing an id gets nowhere

    await h.call(`/api/videos/${VIDEO}/playback/stop`, { cookie: owner.cookie, json: { lease: first.lease } })
    expect((await play(owner)).status).toBe(200)
  })

  it('holds the key route to the lease too: a token from a lapsed lease stops working once someone else took over', async () => {
    h.clock.now += 91_000 // the previous test left a slot behind
    const a = await tokenOf(owner)
    expect((await keyReq(a.token)).status).toBe(200)
    h.clock.now += 91_000 // past LEASE_SECONDS with no heartbeat
    const b = await tokenOf(owner) // the other device takes the free slot
    expect(b.lease).not.toBe(a.lease)
    expect((await keyReq(a.token)).status).toBe(403)
    expect((await keyReq(b.token)).status).toBe(200)
  })
})

describe('lease contract (memory)', () => {
  it('behaves like the Redis version', async () => {
    let t = 0
    const l = memoryLease(() => t)
    const id = (await l.acquire('k', 10))!
    expect(await l.acquire('k', 10)).toBeNull()
    expect(await l.acquire('k', 10, 'wrong')).toBeNull()
    expect(await l.acquire('k', 10, id)).toBe(id)
    expect(await l.hold('k', 'wrong', 10)).toBe(false)
    t = 9_000
    expect(await l.hold('k', id, 10)).toBe(true) // heartbeat extends it
    t = 18_000
    expect(await l.hold('k', id, 10)).toBe(true)
    t = 40_000
    expect(await l.hold('k', id, 10)).toBe(false) // lapsed
    const next = (await l.acquire('k', 10))!
    expect(next).not.toBe(id)
    await l.release('k', id) // not the holder: no effect
    expect(await l.hold('k', next, 10)).toBe(true)
    await l.release('k', next)
    expect(await l.acquire('k', 10)).not.toBeNull()
  })
})
