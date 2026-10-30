import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upload, type FileLike } from '../shared/uploader.js'
import { harness, type Harness } from './harness.js'

const MiB = 1024 * 1024
let h: Harness
let alice: Awaited<ReturnType<Harness['signup']>>
let bob: Awaited<ReturnType<Harness['signup']>>
let carol: Awaited<ReturnType<Harness['signup']>>
let videoId: string
let openUploadId: string

beforeAll(async () => {
  h = await harness()
  ;[alice, bob, carol] = await Promise.all([h.signup('alice@example.com'), h.signup('bob@example.com'), h.signup('carol@example.com')])
  const file = Object.assign(new Blob([randomBytes(MiB + 1)], { type: 'video/mp4' }), { name: 'talk.mp4', lastModified: 1 }) as FileLike
  videoId = (await upload(file, { api: h.api, headers: alice.headers })).id
  openUploadId = (await h.uploads.create(alice.user.id, { filename: 'open.mp4', size: 2 * MiB, contentType: 'video/mp4' })).id
})
afterAll(() => h.close())

describe('strangers', () => {
  it('cannot touch an upload that is not theirs, and cannot tell it exists', async () => {
    const real = await Promise.all([
      h.call(`/api/uploads/${openUploadId}/parts`, { cookie: bob.cookie }),
      h.call(`/api/uploads/${openUploadId}/parts/1/url`, { cookie: bob.cookie, json: { sha256: Buffer.alloc(32).toString('base64') } }),
      h.call(`/api/uploads/${openUploadId}/complete`, { cookie: bob.cookie, method: 'POST' }),
      h.call(`/api/uploads/${openUploadId}`, { cookie: bob.cookie, method: 'DELETE' }),
    ])
    const fake = await h.call('/api/uploads/not-a-real-id/parts', { cookie: bob.cookie })
    for (const r of real) expect(r.status).toBe(404)
    expect(await real[0]!.json()).toEqual(await fake.json())
    // and alice's upload is still open for her
    expect((await h.call(`/api/uploads/${openUploadId}/parts`, { cookie: alice.cookie })).status).toBe(200)
  })

  it('cannot see, list, or delete someone else video', async () => {
    expect((await h.call(`/api/videos/${videoId}`, { cookie: bob.cookie })).status).toBe(404)
    expect((await h.call(`/api/videos/${videoId}`, { cookie: bob.cookie, method: 'DELETE' })).status).toBe(404)
    expect(await (await h.call('/api/videos', { cookie: bob.cookie })).json()).toEqual([])
    expect((await h.call(`/api/videos/${videoId}/viewers`, { cookie: bob.cookie, json: { email: 'x@example.com' } })).status).toBe(404)
  })

  it('cannot fetch the unencrypted thumbnail of someone else video', async () => {
    expect((await h.call(`/api/videos/${videoId}/thumb`, { cookie: alice.cookie })).status).toBe(404) // none made yet
    await h.fake.storage.put(`thumbs/${videoId}.jpg`, Buffer.from('jpeg'), 'image/jpeg')
    const mine = await h.call(`/api/videos/${videoId}/thumb`, { cookie: alice.cookie })
    expect(mine.status).toBe(200)
    expect(mine.headers.get('content-type')).toBe('image/jpeg')
    expect(mine.headers.get('cache-control')).toContain('private')
    expect((await h.call(`/api/videos/${videoId}/thumb`, { cookie: bob.cookie })).status).toBe(404)
    expect((await h.call(`/api/videos/${videoId}/thumb`)).status).toBe(401)
  })

  it('cannot resume an upload by guessing its fingerprint id', async () => {
    const r = await h.call(`/api/uploads/${openUploadId}/parts`, { cookie: carol.cookie })
    expect(r.status).toBe(404)
  })
})

describe('invited viewers', () => {
  it('can read but not manage, and see nothing else', async () => {
    const inv = await h.call(`/api/videos/${videoId}/viewers`, { cookie: alice.cookie, json: { email: ' BOB@example.com' } })
    expect(inv.status).toBe(200)
    expect(((await inv.json()) as { viewers: string[] }).viewers).toEqual(['bob@example.com'])

    const list = (await (await h.call('/api/videos', { cookie: bob.cookie })).json()) as { id: string; role: string; viewers?: string[] }[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: videoId, role: 'viewer' })
    expect(list[0]!.viewers).toBeUndefined() // a viewer does not see who else was invited

    expect((await h.call(`/api/videos/${videoId}`, { cookie: bob.cookie })).status).toBe(200)
    expect((await h.call(`/api/videos/${videoId}`, { cookie: bob.cookie, method: 'DELETE' })).status).toBe(403)
    expect((await h.call(`/api/videos/${videoId}/viewers`, { cookie: bob.cookie, json: { email: 'carol@example.com' } })).status).toBe(403)
    expect((await h.call(`/api/videos/${videoId}/viewers/bob%40example.com`, { cookie: bob.cookie, method: 'DELETE' })).status).toBe(403)
    expect((await h.call(`/api/videos/${videoId}`, { cookie: carol.cookie })).status).toBe(404)
  })

  it('works for someone who signs up after being invited', async () => {
    await h.call(`/api/videos/${videoId}/viewers`, { cookie: alice.cookie, json: { email: 'dave@example.com' } })
    const dave = await h.signup('dave@example.com')
    expect((await h.call(`/api/videos/${videoId}`, { cookie: dave.cookie })).status).toBe(200)
  })

  it('loses access when the invite is removed', async () => {
    expect((await h.call(`/api/videos/${videoId}/viewers/bob%40example.com`, { cookie: alice.cookie, method: 'DELETE' })).status).toBe(204)
    expect((await h.call(`/api/videos/${videoId}`, { cookie: bob.cookie })).status).toBe(404)
  })

  it('validates invites', async () => {
    const invite = (email: string) => h.call(`/api/videos/${videoId}/viewers`, { cookie: alice.cookie, json: { email } })
    expect((await invite('not-an-email')).status).toBe(400)
    expect((await invite('alice@example.com')).status).toBe(400) // owner
    for (let i = 0; i < 49; i++) await invite(`v${i}@example.com`) // dave is already in, so 50 in total
    expect((await invite('one-too-many@example.com')).status).toBe(400)
  })
})

describe('delete', () => {
  it('removes storage objects and records, and the viewers lose it too', async () => {
    const res = await h.call(`/api/videos/${videoId}`, { cookie: alice.cookie, method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(h.fake.deletedPrefixes).toContain(`raw/${videoId}/`)
    expect(await h.videoCol.countDocuments({ _id: videoId })).toBe(0)
    expect(await h.uploadCol.countDocuments({ _id: videoId })).toBe(0)
    expect((await h.call(`/api/videos/${videoId}`, { cookie: alice.cookie })).status).toBe(404)
  })
})
