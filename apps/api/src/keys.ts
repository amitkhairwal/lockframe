import { randomBytes } from 'node:crypto'
import type { Binary, Collection } from 'mongodb'

// One AES-128 key per video and rotation group, shared by every rendition (the cuts are identical).
export interface KeyDoc {
  _id: string // `${videoId}:${group}`
  videoId: string
  group: number
  key: Buffer | Binary
}

export function keyStore(col: Collection<KeyDoc>) {
  const raw = (k: KeyDoc['key']) => (Buffer.isBuffer(k) ? k : Buffer.from((k as Binary).buffer))
  return {
    ensureIndex: () => col.createIndex({ videoId: 1 }),

    // atomic, so two rung encodes asking at once end up with the same key
    async getOrCreate(videoId: string, group: number) {
      const doc = await col.findOneAndUpdate(
        { _id: `${videoId}:${group}` },
        { $setOnInsert: { videoId, group, key: randomBytes(16) } },
        { upsert: true, returnDocument: 'after' },
      )
      return raw(doc!.key)
    },

    async get(videoId: string, group: number) {
      const doc = await col.findOne({ _id: `${videoId}:${group}` })
      return doc ? raw(doc.key) : null
    },

    async removeVideo(videoId: string) {
      await col.deleteMany({ videoId })
    },
  }
}

export type KeyStore = ReturnType<typeof keyStore>
