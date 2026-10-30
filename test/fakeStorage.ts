import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type { Storage, StoredPart } from '../apps/api/src/storage.js'

// In-memory stand-in for S3: presigned urls point at a tiny local http server.
export async function fakeStorage() {
  const parts = new Map<string, Map<number, Buffer>>() // uploadId -> part number -> bytes
  const hooks = { failPut: (_n: number): boolean => false }
  const objects = new Map<string, Buffer>()
  const completed: StoredPart[][] = []
  const deletedPrefixes: string[] = []
  let seq = 0

  const server: Server = createServer((req, res) => {
    const [path, query] = req.url!.split('?')
    const [, , uploadId, n] = path!.split('/')
    const expected = new URLSearchParams(query).get('sha')
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (hooks.failPut(Number(n))) return req.socket.destroy()
      const body = Buffer.concat(chunks)
      const actual = createHash('sha256').update(body).digest('base64')
      // like S3: the signed checksum must match both the header and the real bytes
      if (req.headers['x-amz-checksum-sha256'] !== expected || actual !== expected) {
        return void res.writeHead(400).end('BadDigest')
      }
      parts.get(uploadId!)?.set(Number(n), body)
      res.writeHead(200, { etag: `"${n}"` }).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const storage: Storage = {
    async create() {
      const id = `u${++seq}`
      parts.set(id, new Map())
      return id
    },
    async presignPart(_key, uploadId, n, sha256) {
      return `${base}/put/${uploadId}/${n}?${new URLSearchParams({ sha: sha256 })}`
    },
    async listParts(_key, uploadId): Promise<StoredPart[]> {
      return [...(parts.get(uploadId)?.entries() ?? [])].map(([n, b]) => ({ n, size: b.length, etag: `"${n}"` }))
    },
    async complete(_key, _uploadId, p) {
      completed.push(p)
    },
    async abort(_key, uploadId) {
      parts.delete(uploadId)
    },
    async deletePrefix(prefix) {
      deletedPrefixes.push(prefix)
      return 1
    },
    async put(key, body) {
      objects.set(key, Buffer.from(body))
    },
    async putFile() {},
    async get(key) {
      const body = objects.get(key)
      return body ? { body: Readable.from(body), length: body.length, type: 'application/octet-stream' } : null
    },
    async presignGet(key) {
      return `${base}/get/${key}`
    },
  }

  return { storage, parts, objects, hooks, completed, deletedPrefixes, close: () => new Promise<void>((r) => server.close(() => r())) }
}
