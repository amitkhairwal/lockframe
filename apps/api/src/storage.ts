import type { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from './config.js'

export interface StoredPart {
  n: number
  size: number
  etag: string
  sha256?: string // base64, as the storage computed it
}

export interface Storage {
  create(key: string, contentType: string): Promise<string>
  presignPart(key: string, uploadId: string, n: number, sha256: string): Promise<string>
  listParts(key: string, uploadId: string): Promise<StoredPart[]>
  complete(key: string, uploadId: string, parts: StoredPart[]): Promise<void>
  abort(key: string, uploadId: string): Promise<void>
  deletePrefix(prefix: string): Promise<number>
  put(key: string, body: string | Buffer, contentType: string): Promise<void>
  putFile(key: string, path: string, contentType: string): Promise<void>
  presignGet(key: string, ttlSeconds: number): Promise<string>
  get(key: string): Promise<{ body: Readable; length?: number; type?: string } | null>
}

const PRESIGN_SECONDS = 15 * 60

function client(endpoint: string | undefined) {
  const { region, accessKey, secretKey } = config.s3
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    // newer SDKs add a CRC32 header that R2 and most S3 clones reject on presigned parts
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

export function s3Storage(): Storage {
  const Bucket = config.s3.bucket
  const direct = client(config.s3.endpoint)
  const signer = client(config.s3.publicEndpoint)

  return {
    async create(Key, ContentType) {
      const out = await direct.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType, ChecksumAlgorithm: 'SHA256' }))
      if (!out.UploadId) throw new Error('storage returned no upload id')
      return out.UploadId
    },

    // the checksum is part of the signature: storage refuses bytes that do not hash to it
    presignPart(Key, UploadId, PartNumber, ChecksumSHA256) {
      return getSignedUrl(
        signer,
        new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, ChecksumSHA256, ChecksumAlgorithm: 'SHA256' }),
        { expiresIn: PRESIGN_SECONDS, unhoistableHeaders: new Set(['x-amz-checksum-sha256']) },
      )
    },

    // storage is the source of truth for what arrived, so always ask it
    async listParts(Key, UploadId) {
      const parts: StoredPart[] = []
      let marker: string | undefined
      do {
        const out = await direct.send(
          new ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker: marker }),
        )
        for (const p of out.Parts ?? []) {
          parts.push({ n: p.PartNumber!, size: p.Size!, etag: p.ETag!, sha256: p.ChecksumSHA256 })
        }
        marker = out.IsTruncated ? String(out.NextPartNumberMarker) : undefined
      } while (marker)
      return parts
    },

    async complete(Key, UploadId, parts) {
      await direct.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.n, ETag: p.etag, ChecksumSHA256: p.sha256 })) },
        }),
      )
    },

    async abort(Key, UploadId) {
      await direct.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }))
    },

    async put(Key, Body, ContentType) {
      await direct.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }))
    },

    // streams from disk, so a segment never has to fit in memory twice
    async putFile(Key, path, ContentType) {
      const { size } = await stat(path)
      await direct.send(new PutObjectCommand({ Bucket, Key, Body: createReadStream(path), ContentLength: size, ContentType }))
    },

    // for ffmpeg and ffprobe, which run next to the worker, so the internal endpoint is right
    presignGet(Key, ttlSeconds) {
      return getSignedUrl(direct, new GetObjectCommand({ Bucket, Key }), { expiresIn: ttlSeconds })
    },

    // null when the object does not exist
    async get(Key) {
      try {
        const out = await direct.send(new GetObjectCommand({ Bucket, Key }))
        return { body: out.Body as Readable, length: out.ContentLength, type: out.ContentType }
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null
        throw err
      }
    },

    // removes everything under a video's prefix, returns how many objects went
    async deletePrefix(Prefix) {
      let deleted = 0
      let token: string | undefined
      do {
        const page = await direct.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token }))
        const Objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }))
        if (Objects.length) {
          await direct.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }))
          deleted += Objects.length
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
      return deleted
    },
  }
}
