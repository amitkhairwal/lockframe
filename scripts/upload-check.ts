// Phase 1 exit check: upload a big file through a proxy that cuts the connection
// part way, resume it, and prove the object in storage is byte-identical.
// Needs a real S3 endpoint: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY.
// Optional: SIZE_MB (default 512), MONGODB_URI (default: in-memory mongod).
import { createHash, randomBytes } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

const target = new URL(process.env.S3_ENDPOINT ?? '')
const sizeMb = Number(process.env.SIZE_MB ?? 512)
const MiB = 1024 * 1024

async function makeFile(bytes: number) {
  const path = join(tmpdir(), `lockframe-check-${process.pid}.mp4`)
  const fh = await open(path, 'w')
  const hash = createHash('sha256')
  for (let done = 0; done < bytes; done += 8 * MiB) {
    const chunk = randomBytes(Math.min(8 * MiB, bytes - done))
    hash.update(chunk)
    await fh.write(chunk)
  }
  await fh.close()
  return { path, sha256: hash.digest('hex') }
}

// TCP proxy in front of storage. `cutAfter` bytes from clients, then every socket dies.
function startProxy() {
  const state = { up: 0, cutAfter: Infinity, sockets: new Set<net.Socket>() }
  const server = net.createServer((client) => {
    if (state.up >= state.cutAfter) return client.destroy()
    const upstream = net.connect(Number(target.port || 80), target.hostname)
    state.sockets.add(client).add(upstream)
    client.on('data', (b) => {
      state.up += b.length
      if (state.up >= state.cutAfter) state.sockets.forEach((s) => s.destroy())
    })
    client.pipe(upstream)
    upstream.pipe(client)
    for (const s of [client, upstream]) s.on('error', () => {}).on('close', () => state.sockets.delete(s))
  })
  return new Promise<{ state: typeof state; port: number; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ state, port: (server.address() as net.AddressInfo).port, close: () => server.close() }),
    ),
  )
}

const proxy = await startProxy()
process.env.S3_PUBLIC_ENDPOINT = `http://127.0.0.1:${proxy.port}`
process.env.PART_BYTES ??= String(8 * MiB)
process.env.MAX_UPLOAD_BYTES ??= String(20 * 1024 * MiB)
process.env.NODE_ENV = 'test'

const { buildApp } = await import('../apps/api/src/app.js')
const { s3Storage } = await import('../apps/api/src/storage.js')
const { uploadService } = await import('../apps/api/src/uploads.js')
const { authService } = await import('../apps/api/src/auth.js')
const { videoService } = await import('../apps/api/src/videos.js')
const { upload } = await import('../shared/uploader.js')
const { MongoClient } = await import('mongodb')
const { config } = await import('../apps/api/src/config.js')

let memory: { stop(): Promise<boolean> } | undefined
let mongoUri = process.env.MONGODB_URI
if (!mongoUri) {
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  const m = await MongoMemoryServer.create()
  memory = m
  mongoUri = m.getUri()
}
const mongo = await MongoClient.connect(mongoUri)
const db = mongo.db(`upload_check_${Date.now()}`)
const col = db.collection<import('../apps/api/src/uploads.js').UploadDoc>('uploads')
const users = db.collection<import('../apps/api/src/auth.js').UserDoc>('users')
await users.createIndex({ email: 1 }, { unique: true })
const storage = s3Storage()
const videos = videoService(db.collection('videos'), col, storage)
const { playbackService } = await import('../apps/api/src/playback.js')
const { keyStore } = await import('../apps/api/src/keys.js')
const { memoryLease } = await import('../apps/api/src/lease.js')
const playback = playbackService(db.collection('videos'), keyStore(db.collection('keys')), memoryLease())
const { understandService, understandStore } = await import('../apps/api/src/understand.js')
const understand = understandService(db.collection('videos'), understandStore(db.collection('transcripts'), db.collection('chunks')), null)
const app = buildApp({ uploads: uploadService(col, storage, (u) => videos.fromUpload(u)), auth: authService(users), videos, playback, storage, understand, analytics: (await import('../apps/api/src/analytics.js')).makeAnalytics(db, null) })
await app.listen({ port: 0, host: '127.0.0.1' })
const api = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`

const signup = await fetch(`${api}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'check@example.com', password: 'a long check password' }),
})
const cookie = signup.headers.getSetCookie()[0]!.split(';')[0]!
const headers = { cookie }

const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
})
await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket })) // fail fast on a bad bucket

const total = sizeMb * MiB
console.log(`making a ${sizeMb} MiB file`)
const file = await makeFile(total)
const blob = Object.assign(await openAsBlob(file.path, { type: 'video/mp4' }), { name: 'check.mp4', lastModified: 1 })
const store = new Map<string, string>()
const kv = { get: (k: string) => store.get(k), set: (k: string, v: string) => void store.set(k, v), delete: (k: string) => void store.delete(k) }

let failed = false
function check(ok: boolean, msg: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failed = true
}

// tamper check: storage must refuse bytes that do not match the signed checksum
{
  const post = (path: string, body?: unknown) =>
    fetch(api + path, { method: path.endsWith('/url') || path === '/api/uploads' ? 'POST' : 'DELETE', headers: body ? { 'content-type': 'application/json', cookie } : { cookie }, body: body ? JSON.stringify(body) : undefined })
  const plan = (await (await post('/api/uploads', { filename: 't.mp4', size: 5 * MiB, contentType: 'video/mp4' })).json()) as { id: string }
  const claimed = createHash('sha256').update(Buffer.alloc(5 * MiB, 0)).digest('base64')
  const signed = (await (await post(`/api/uploads/${plan.id}/parts/1/url`, { sha256: claimed })).json()) as { url: string; headers: Record<string, string> }
  const put = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: Buffer.alloc(5 * MiB, 1) })
  check(!put.ok, `storage refused a part with the wrong bytes (status ${put.status})`)
  await post(`/api/uploads/${plan.id}`)
}

// run 1: cut part way through
proxy.state.cutAfter = total * 0.6 // after the first wave of parts finished, in the middle of the second
let firstRunFailed = false
await upload(blob, { api, headers, store: kv, retries: 0, concurrency: 4 }).catch(() => (firstRunFailed = true))
check(firstRunFailed, 'first run died when the connection was cut')
const sentBeforeCut = proxy.state.up

// run 2: network is back
proxy.state.up = 0
proxy.state.cutAfter = Infinity
const r = await upload(blob, { api, headers, store: kv })
const bytesOnWire = proxy.state.up
const doc = await col.findOne({ _id: r.id })
check(r.partsSkipped > 0, `resume skipped ${r.partsSkipped} parts that were already stored`)
check(r.bytesSent < total, 'resume did not send the whole file again')
check(doc?.status === 'uploaded', 'upload marked uploaded')

// the object must match the original byte for byte
const obj = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: doc!.key }))
const hash = createHash('sha256')
await pipeline(obj.Body as NodeJS.ReadableStream, hash)
check(hash.digest('hex') === file.sha256, 'sha256 of stored object equals the source file')
check(Number(obj.ContentLength) === total, `stored size is ${obj.ContentLength} bytes`)

// delete through the API, then storage must hold nothing under the video's prefix
const del = await fetch(`${api}/api/videos/${r.id}`, { method: 'DELETE', headers })
const left = await s3.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: `raw/${r.id}/` }))
check(del.status === 204 && !left.KeyCount, `delete removed the stored objects (status ${del.status}, ${left.KeyCount ?? 0} left)`)

console.log(JSON.stringify({ sizeMiB: sizeMb, firstRunWireMiB: +(sentBeforeCut / MiB).toFixed(1), resumeWireMiB: +(bytesOnWire / MiB).toFixed(1), partsSkipped: r.partsSkipped, partsResent: r.partsSent, partCount: doc?.partCount }))

await rm(file.path, { force: true })
await app.close()
await mongo.close()
await memory?.stop()
proxy.close()
process.exit(failed ? 1 : 0)
