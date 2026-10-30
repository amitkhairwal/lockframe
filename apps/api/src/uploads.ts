import { randomUUID } from 'node:crypto'
import type { Collection } from 'mongodb'
import { config } from './config.js'
import type { Storage, StoredPart } from './storage.js'

const MiB = 1024 * 1024
const MAX_PARTS = 10_000 // S3 limit

export interface UploadDoc {
  _id: string
  owner: string
  key: string
  s3UploadId: string
  filename: string
  contentType: string
  size: number
  partBytes: number
  partCount: number
  // checksum signed for each part; some S3 hosts do not echo it back from ListParts
  sums?: Record<string, string>
  status: 'uploading' | 'uploaded' | 'aborted'
  createdAt: Date
  completedAt?: Date
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const expectedSize = (u: UploadDoc, n: number) =>
  n < u.partCount ? u.partBytes : u.size - u.partBytes * (u.partCount - 1)

export function uploadService(
  uploads: Collection<UploadDoc>,
  storage: Storage,
  onUploaded: (u: UploadDoc) => Promise<void> | void = () => {},
) {
  // someone else's upload looks the same as one that does not exist
  async function load(owner: string, id: string) {
    const u = await uploads.findOne({ _id: id, owner })
    if (!u) throw new HttpError(404, 'upload not found')
    return u
  }

  const loadOpen = async (owner: string, id: string) => {
    const u = await load(owner, id)
    if (u.status !== 'uploading') throw new HttpError(409, `upload is ${u.status}`)
    return u
  }

  return {
    async create(owner: string, input: { filename: unknown; size: unknown; contentType: unknown }) {
      const { filename, size, contentType } = input
      if (typeof filename !== 'string' || !filename || filename.length > 255) {
        throw new HttpError(400, 'filename is required (max 255 chars)')
      }
      if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > config.maxUploadBytes) {
        throw new HttpError(400, `size must be between 1 and ${config.maxUploadBytes} bytes`)
      }
      if (typeof contentType !== 'string' || !contentType.startsWith('video/')) {
        throw new HttpError(400, 'contentType must be a video type')
      }

      // grow the part size for huge files so we stay under 10k parts
      const total = size as number
      const partBytes = Math.max(config.partBytes, Math.ceil(total / MAX_PARTS / MiB) * MiB)
      const partCount = Math.ceil(total / partBytes)

      const id = randomUUID()
      const safe = filename.replace(/[^\w.-]+/g, '_')
      const key = `raw/${id}/${safe}`
      const s3UploadId = await storage.create(key, contentType)

      const doc: UploadDoc = {
        _id: id,
        owner,
        key,
        s3UploadId,
        filename,
        contentType,
        size: total,
        partBytes,
        partCount,
        status: 'uploading',
        createdAt: new Date(),
      }
      await uploads.insertOne(doc)
      return { id, partBytes, partCount }
    },

    async parts(owner: string, id: string) {
      const u = await loadOpen(owner, id)
      const parts = await storage.listParts(u.key, u.s3UploadId)
      return { partBytes: u.partBytes, partCount: u.partCount, parts: parts.map(({ n, size }) => ({ n, size })) }
    },

    async signPart(owner: string, id: string, n: number, sha256: unknown) {
      const u = await loadOpen(owner, id)
      if (!Number.isInteger(n) || n < 1 || n > u.partCount) throw new HttpError(400, 'part number out of range')
      // base64 of a 32 byte digest is always 44 chars
      if (typeof sha256 !== 'string' || Buffer.from(sha256, 'base64').length !== 32) {
        throw new HttpError(400, 'sha256 must be the base64 SHA-256 of the part')
      }
      await uploads.updateOne({ _id: id }, { $set: { [`sums.${n}`]: sha256 } })
      return {
        url: await storage.presignPart(u.key, u.s3UploadId, n, sha256),
        headers: { 'x-amz-checksum-sha256': sha256 }, // the PUT must carry these
        size: expectedSize(u, n),
      }
    },

    async complete(owner: string, id: string) {
      const u = await load(owner, id)
      if (u.status === 'uploaded') {
        await onUploaded(u) // idempotent, covers a crash between the status update and the hook
        return { id, status: u.status } // retry after a lost response
      }
      if (u.status !== 'uploading') throw new HttpError(409, `upload is ${u.status}`)

      const stored = await storage.listParts(u.key, u.s3UploadId)
      const byNumber = new Map<number, StoredPart>(stored.map((p) => [p.n, p]))
      const missing: number[] = []
      for (let n = 1; n <= u.partCount; n++) {
        const p = byNumber.get(n)
        if (!p || p.size !== expectedSize(u, n)) missing.push(n)
      }
      if (missing.length) {
        throw new HttpError(409, `missing or wrong-size parts: ${missing.slice(0, 20).join(',')}`)
      }

      const ordered = [...byNumber.values()]
        .sort((a, b) => a.n - b.n)
        .map((p) => ({ ...p, sha256: p.sha256 ?? u.sums?.[p.n] }))
      await storage.complete(u.key, u.s3UploadId, ordered)
      const done = { status: 'uploaded' as const, completedAt: new Date() }
      await uploads.updateOne({ _id: id }, { $set: done })
      await onUploaded({ ...u, ...done })
      return { id, status: done.status }
    },

    async abort(owner: string, id: string) {
      const u = await loadOpen(owner, id)
      await storage.abort(u.key, u.s3UploadId)
      await uploads.updateOne({ _id: id }, { $set: { status: 'aborted' } })
    },

    // abandoned uploads keep billing for their parts until aborted
    async sweepStale(now = new Date()) {
      const cutoff = new Date(now.getTime() - config.staleUploadHours * 3600_000)
      let swept = 0
      for await (const u of uploads.find({ status: 'uploading', createdAt: { $lt: cutoff } })) {
        await storage.abort(u.key, u.s3UploadId).catch(() => {}) // already gone is fine
        await uploads.updateOne({ _id: u._id }, { $set: { status: 'aborted' } })
        swept++
      }
      return swept
    },
  }
}

export type UploadService = ReturnType<typeof uploadService>
