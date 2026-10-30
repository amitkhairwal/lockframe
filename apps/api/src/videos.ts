import type { Collection } from 'mongodb'
import type { SessionUser } from './auth.js'
import { isEmail, normalizeEmail } from './auth.js'
import type { KeyStore } from './keys.js'
import type { Storage } from './storage.js'
import { HttpError, type UploadDoc } from './uploads.js'

export type VideoStatus = 'uploaded' | 'processing' | 'ready' | 'failed'

export interface RenditionDoc {
  height: number
  width: number
  progress: number
  bandwidth?: number
  segments?: number
  bytes?: number
}

export interface VideoDoc {
  _id: string // same id as the upload it came from
  owner: string
  title: string
  status: VideoStatus
  size: number
  createdAt: Date
  viewers: string[] // emails of invited viewers
  rawKey: string
  run: number // bumped on every retry, so jobs from an older run can tell they are stale
  progress: number // 0 to 100 across the whole pipeline
  failure?: string
  retryable?: boolean
  duration?: number
  source?: { width: number; height: number; fps: number; hasAudio: boolean; codec: string }
  renditions?: RenditionDoc[]
  timings?: Record<string, { waitMs: number; ms: number }>
  readyAt?: Date
  understanding?: 'pending' | 'running' | 'done' | 'failed' | 'off'
  understandingError?: string
  uRun?: number // bumped each time understanding is retried
}

export const canAccess = (v: Pick<VideoDoc, 'owner' | 'viewers'>, u: SessionUser) => v.owner === u.id || v.viewers.includes(u.email)

const MAX_VIEWERS = 50

export function videoService(
  videos: Collection<VideoDoc>,
  uploads: Collection<UploadDoc>,
  storage: Storage,
  enqueue: (videoId: string, run: number) => Promise<void> = async () => {},
  keys: Pick<KeyStore, 'removeVideo'> = { removeVideo: async () => {} },
  forget: (videoId: string) => Promise<void> = async () => {},
) {
  const view = (v: VideoDoc, user: SessionUser) => ({
    id: v._id,
    title: v.title,
    status: v.status,
    size: v.size,
    createdAt: v.createdAt,
    progress: v.progress,
    failure: v.failure,
    retryable: v.retryable,
    duration: v.duration,
    heights: v.renditions?.map((r) => r.height),
    understanding: v.understanding,
    role: v.owner === user.id ? ('owner' as const) : ('viewer' as const),
    // only the owner sees who else has access
    viewers: v.owner === user.id ? v.viewers : undefined,
  })

  async function find(user: SessionUser, id: string) {
    const v = await videos.findOne({ _id: id, $or: [{ owner: user.id }, { viewers: user.email }] })
    if (!v) throw new HttpError(404, 'video not found')
    return v
  }

  async function findOwned(user: SessionUser, id: string) {
    const v = await find(user, id)
    if (v.owner !== user.id) throw new HttpError(403, 'only the owner can do that')
    return v
  }

  return {
    // called when an upload completes; safe to call twice
    async fromUpload(u: UploadDoc) {
      const title = u.filename.replace(/\.[^.]+$/, '').slice(0, 200) || 'Untitled'
      await videos.updateOne(
        { _id: u._id },
        {
          $setOnInsert: {
            owner: u.owner, title, status: 'uploaded', size: u.size, createdAt: new Date(), viewers: [],
            rawKey: u.key, run: 1, progress: 0,
          },
        },
        { upsert: true },
      )
      // job ids make a second enqueue a no-op; the status check keeps a finished video from being queued again
      const v = await videos.findOne({ _id: u._id })
      if (v?.status === 'uploaded') await enqueue(v._id, v.run)
    },

    async list(user: SessionUser) {
      const rows = await videos.find({ $or: [{ owner: user.id }, { viewers: user.email }] }).sort({ createdAt: -1 }).limit(200).toArray()
      return rows.map((v) => view(v, user))
    },

    async get(user: SessionUser, id: string) {
      return view(await find(user, id), user)
    },

    async invite(user: SessionUser, id: string, emailIn: unknown) {
      const v = await findOwned(user, id)
      const email = normalizeEmail(emailIn)
      if (!isEmail(email)) throw new HttpError(400, 'enter a valid email')
      if (email === user.email) throw new HttpError(400, 'you already own this video')
      if (!v.viewers.includes(email) && v.viewers.length >= MAX_VIEWERS) throw new HttpError(400, `at most ${MAX_VIEWERS} viewers`)
      await videos.updateOne({ _id: id }, { $addToSet: { viewers: email } })
      return view((await videos.findOne({ _id: id }))!, user)
    },

    async uninvite(user: SessionUser, id: string, emailIn: unknown) {
      await findOwned(user, id)
      await videos.updateOne({ _id: id }, { $pull: { viewers: normalizeEmail(emailIn) } })
    },

    // only a transient failure can be retried; a file that is not a video stays failed
    async retry(user: SessionUser, id: string) {
      await findOwned(user, id)
      const v = await videos.findOneAndUpdate(
        { _id: id, status: 'failed', retryable: true },
        { $inc: { run: 1 }, $set: { status: 'uploaded', progress: 0 }, $unset: { failure: '', retryable: '', renditions: '', understanding: '', understandingError: '' } },
        { returnDocument: 'after' },
      )
      if (!v) throw new HttpError(409, 'this video cannot be retried')
      await enqueue(v._id, v.run)
      return view(v, user)
    },

    // objects first: if this fails halfway the record is still there to retry from
    async remove(user: SessionUser, id: string) {
      await findOwned(user, id)
      await storage.deletePrefix(`raw/${id}/`)
      await storage.deletePrefix(`hls/${id}/`)
      await storage.deletePrefix(`thumbs/${id}.`)
      await keys.removeVideo(id)
      await forget(id)
      await videos.deleteOne({ _id: id })
      await uploads.deleteOne({ _id: id })
    },
  }
}

export type VideoService = ReturnType<typeof videoService>
