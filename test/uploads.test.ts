import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { upload, type FileLike } from '../shared/uploader.js'
import { harness, type Harness } from './harness.js'

const MiB = 1024 * 1024
const video = (bytes: number, name = 'clip.mp4') =>
  Object.assign(new Blob([randomBytes(bytes)], { type: 'video/mp4' }), { name, lastModified: 1 }) as FileLike

let h: Harness
let alice: Awaited<ReturnType<Harness['signup']>>

beforeAll(async () => {
  h = await harness()
  alice = await h.signup('alice@example.com')
})
afterAll(() => h.close())
beforeEach(() => {
  h.fake.hooks.failPut = () => false
})

const send = (file: FileLike, opts: Partial<Parameters<typeof upload>[1]> = {}) =>
  upload(file, { api: h.api, headers: alice.headers, ...opts })

describe('create', () => {
  const post = (json: unknown) => h.call('/api/uploads', { json, cookie: alice.cookie })

  it('rejects bad input', async () => {
    expect((await post({ filename: '', size: 5, contentType: 'video/mp4' })).status).toBe(400)
    expect((await post({ filename: 'a.mp4', size: 0, contentType: 'video/mp4' })).status).toBe(400)
    expect((await post({ filename: 'a.mp4', size: 1.5, contentType: 'video/mp4' })).status).toBe(400)
    expect((await post({ filename: 'a.mp4', size: 101 * MiB, contentType: 'video/mp4' })).status).toBe(400)
    expect((await post({ filename: 'a.exe', size: 5, contentType: 'application/x-msdownload' })).status).toBe(400)
  })

  it('plans parts for an accepted file', async () => {
    const res = await post({ filename: 'a b.mp4', size: 2.5 * MiB, contentType: 'video/mp4' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ partBytes: MiB, partCount: 3 })
  })
})

describe('upload and resume', () => {
  it('uploads a file in parts, completes, and creates the video record', async () => {
    const file = video(3.5 * MiB, 'My Lecture.mp4')
    const r = await send(file)
    expect(r).toMatchObject({ partsSent: 4, partsSkipped: 0, bytesSent: file.size })
    expect((await h.uploadCol.findOne({ _id: r.id }))?.status).toBe('uploaded')
    const v = await h.videoCol.findOne({ _id: r.id })
    expect(v).toMatchObject({ owner: alice.user.id, title: 'My Lecture', status: 'uploaded', size: file.size })
  })

  it('resumes after a failure and sends only the missing parts', async () => {
    const file = video(8 * MiB, 'big.mp4')
    const store = new Map<string, string>()
    const kv = { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v), delete: (k: string) => void store.delete(k) }

    // storage drops the connection for parts 5 and up, retries off: first run must fail
    h.fake.hooks.failPut = (n) => n >= 5
    await expect(send(file, { store: kv, retries: 0, concurrency: 1 })).rejects.toThrow()
    expect(store.size).toBe(1)

    h.fake.hooks.failPut = () => false
    const r = await send(file, { store: kv })
    expect(r.partsSkipped).toBe(4)
    expect(r.partsSent).toBe(4)
    expect(r.bytesSent).toBe(4 * MiB)
    expect(store.size).toBe(0)

    const doc = await h.uploadCol.findOne({ _id: r.id })
    const stored = Buffer.concat([...h.fake.parts.get(doc!.s3UploadId)!.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b))
    expect(stored.equals(Buffer.from(await file.arrayBuffer()))).toBe(true)
  })

  it('retries a flaky part on its own', async () => {
    let hits = 0
    h.fake.hooks.failPut = (n) => n === 2 && hits++ < 2
    const r = await send(video(3 * MiB), { backoffMs: 1 })
    expect(r.partsSent).toBe(3)
    expect(hits).toBeGreaterThanOrEqual(3)
  })
})

describe('part checksum', () => {
  it('rejects a part whose bytes do not match the signed checksum', async () => {
    const plan = await h.uploads.create(alice.user.id, { filename: 'x.mp4', size: MiB, contentType: 'video/mp4' })
    const good = Buffer.alloc(MiB, 1)
    const sha = createHash('sha256').update(good).digest('base64')
    const signed = await h.uploads.signPart(alice.user.id, plan.id, 1, sha)
    const bad = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: Buffer.alloc(MiB, 2) })
    expect(bad.status).toBe(400)
    const ok = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: good })
    expect(ok.status).toBe(200)
  })

  it('needs a well formed checksum to sign', async () => {
    const plan = await h.uploads.create(alice.user.id, { filename: 'x.mp4', size: MiB, contentType: 'video/mp4' })
    await expect(h.uploads.signPart(alice.user.id, plan.id, 1, 'nope')).rejects.toMatchObject({ status: 400 })
  })
})

describe('complete', () => {
  it('refuses while parts are missing', async () => {
    const plan = await h.uploads.create(alice.user.id, { filename: 'x.mp4', size: 2 * MiB, contentType: 'video/mp4' })
    await expect(h.uploads.complete(alice.user.id, plan.id)).rejects.toMatchObject({ status: 409 })
  })

  it('refuses a part with the wrong size', async () => {
    const plan = await h.uploads.create(alice.user.id, { filename: 'x.mp4', size: 2 * MiB, contentType: 'video/mp4' })
    const doc = await h.uploadCol.findOne({ _id: plan.id })
    h.fake.parts.get(doc!.s3UploadId)!.set(1, Buffer.alloc(10))
    h.fake.parts.get(doc!.s3UploadId)!.set(2, Buffer.alloc(MiB))
    await expect(h.uploads.complete(alice.user.id, plan.id)).rejects.toMatchObject({ status: 409 })
  })

  it('passes each part checksum to storage even when listing does not return it', async () => {
    const r = await send(video(2 * MiB + 1))
    const sent = h.fake.completed.at(-1)!
    expect(sent).toHaveLength(3)
    expect(sent.every((p) => p.sha256?.length === 44)).toBe(true)
    expect(r.partsSent).toBe(3)
  })

  it('can be called twice after success without a second video', async () => {
    const r = await send(video(MiB + 5))
    expect(await h.uploads.complete(alice.user.id, r.id)).toMatchObject({ status: 'uploaded' })
    expect(await h.videoCol.countDocuments({ _id: r.id })).toBe(1)
  })

  it('creates the video on a retry if the first attempt died before the hook ran', async () => {
    const r = await send(video(MiB + 7))
    await h.videoCol.deleteOne({ _id: r.id })
    await h.uploads.complete(alice.user.id, r.id)
    expect(await h.videoCol.countDocuments({ _id: r.id })).toBe(1)
  })
})

describe('abort and cleanup', () => {
  it('aborts an open upload and blocks further use', async () => {
    const plan = await h.uploads.create(alice.user.id, { filename: 'x.mp4', size: MiB, contentType: 'video/mp4' })
    await h.uploads.abort(alice.user.id, plan.id)
    await expect(h.uploads.signPart(alice.user.id, plan.id, 1, 'x')).rejects.toMatchObject({ status: 409 })
  })

  it('sweeps uploads older than the limit', async () => {
    const old = await h.uploads.create(alice.user.id, { filename: 'old.mp4', size: MiB, contentType: 'video/mp4' })
    const fresh = await h.uploads.create(alice.user.id, { filename: 'new.mp4', size: MiB, contentType: 'video/mp4' })
    await h.uploadCol.updateOne({ _id: old.id }, { $set: { createdAt: new Date(Date.now() - 48 * 3600_000) } })
    expect(await h.uploads.sweepStale()).toBeGreaterThanOrEqual(1)
    expect((await h.uploadCol.findOne({ _id: old.id }))?.status).toBe('aborted')
    expect((await h.uploadCol.findOne({ _id: fresh.id }))?.status).toBe('uploading')
  })
})
