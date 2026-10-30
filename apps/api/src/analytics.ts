import type { Collection, Db, ObjectId } from 'mongodb'
import { parseJson } from './transcript.js'
import { type Ai } from './ai.js'
import type { SessionUser } from './auth.js'
import { config } from './config.js'
import { evaluate, groupStart, RULE_TEXT, type EventType, type Hit, type Rule } from './rules.js'
import { HttpError } from './uploads.js'
import { canAccess, type VideoDoc } from './videos.js'

export interface WatchDoc {
  _id: string // `${user}:${video}`
  user: string
  video: string
  position: number // seconds, as last reported by the player
  completed: boolean
  updatedAt: Date
}

export interface EventDoc {
  _id?: ObjectId
  video: string
  user: string // an id, never an email: events are the bulky, expiring record
  type: EventType
  position?: number
  group?: number
  gap?: number
  at: Date
}

export interface FlagDoc {
  _id: string // `${video}:${user}:${rule}`, so one flag per rule and viewer
  video: string
  owner: string
  user: string
  viewer: string // email, for display
  rule: Rule
  count: number
  windowMinutes: number
  firstAt: Date
  lastAt: Date
  status: 'open' | 'dismissed'
  summary?: string
  summaryAt?: Date
  summarizedCount?: number
  summaryTriedAt?: Date
}

export const CLIENT_EVENTS = ['progress', 'play', 'pause', 'seek', 'ended'] as const
type ClientEvent = (typeof CLIENT_EVENTS)[number]

const SUMMARY_SYSTEM = `You write a short note for the owner of a video about a rule that fired on one viewer's playback.
Use only the facts in the JSON. Do not invent reasons. The rules are heuristics, so do not accuse anyone.
Write at most 2 sentences: what happened, then one sensible next step such as asking the viewer or removing their access.
Reply with JSON only: {"summary": string}.`

export function analyticsService(
  videos: Collection<VideoDoc>,
  watch: Collection<WatchDoc>,
  events: Collection<EventDoc>,
  flags: Collection<FlagDoc>,
  ai: Ai | null,
  now: () => Date = () => new Date(),
) {
  const pending = new Set<Promise<unknown>>()

  async function summarize(flag: FlagDoc, video: Pick<VideoDoc, 'duration'>) {
    if (!ai) return
    await flags.updateOne({ _id: flag._id }, { $set: { summaryTriedAt: now() } })
    const facts = {
      rule: flag.rule,
      meaning: RULE_TEXT[flag.rule],
      timesSeen: flag.count,
      withinMinutes: flag.windowMinutes,
      videoLengthMinutes: video.duration ? Math.round(video.duration / 60) : undefined,
      firstSeen: flag.firstAt.toISOString(),
      lastSeen: flag.lastAt.toISOString(),
    }
    try {
      const raw = parseJson(await ai.chat([{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: JSON.stringify(facts) }], { json: true })) as { summary?: unknown }
      const text = typeof raw?.summary === 'string' ? raw.summary.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
      if (text) await flags.updateOne({ _id: flag._id }, { $set: { summary: text, summaryAt: now(), summarizedCount: flag.count } })
    } catch {
      // the flag still shows its rule text; a summary is only a nicety
    }
  }

  async function raise(video: VideoDoc, user: SessionUser, hit: Hit) {
    const at = now()
    const _id = `${video._id}:${user.id}:${hit.rule}`
    const before = await flags.findOneAndUpdate(
      { _id },
      {
        $set: { count: hit.count, windowMinutes: hit.windowMinutes, lastAt: at, viewer: user.email },
        $setOnInsert: { video: video._id, owner: video.owner, user: user.id, rule: hit.rule, firstAt: at, status: 'open' },
      },
      { upsert: true, returnDocument: 'before' },
    )
    // write a summary when the flag is new, retry one that failed, or refresh it once the count has doubled; never more than one per cooldown
    const cooled = !before?.summaryTriedAt || at.getTime() - before.summaryTriedAt.getTime() >= config.flags.summaryCooldownMin * 60_000
    const due = !before || (cooled && (!before.summary || hit.count >= (before.summarizedCount ?? 0) * 2))
    if (due && ai) {
      const doc = (await flags.findOne({ _id }))!
      const job = summarize(doc, video).finally(() => pending.delete(job))
      pending.add(job)
    }
  }

  async function detect(video: VideoDoc, user: SessionUser) {
    const since = new Date(now().getTime() - 60 * 60_000)
    const recent = await events.find({ video: video._id, user: user.id, at: { $gte: since } }, { projection: { type: 1, at: 1 } }).toArray()
    for (const hit of evaluate(recent, now())) await raise(video, user, hit)
  }

  async function serverEvent(video: VideoDoc, user: SessionUser, type: EventType, extra: Partial<EventDoc> = {}) {
    await events.insertOne({ video: video._id, user: user.id, type, at: now(), ...extra })
    await detect(video, user)
  }

  async function watchable(user: SessionUser, id: string) {
    const v = await videos.findOne({ _id: id })
    if (!v || !canAccess(v, user)) throw new HttpError(404, 'video not found')
    return v
  }

  return {
    ensureIndexes: () =>
      Promise.all([
        events.createIndex({ video: 1, user: 1, at: -1 }),
        events.createIndex({ at: 1 }, { expireAfterSeconds: config.eventDays * 86400 }), // old events are dropped by Mongo itself
        flags.createIndex({ owner: 1, status: 1, lastAt: -1 }),
        watch.createIndex({ video: 1 }),
      ]),

    // what the player reports. "progress" only moves the saved position, the rest are also kept as events.
    async record(user: SessionUser, videoId: string, typeIn: unknown, positionIn: unknown) {
      const type = CLIENT_EVENTS.find((t) => t === typeIn) as ClientEvent | undefined
      if (!type) throw new HttpError(400, 'unknown event')
      if (typeof positionIn !== 'number' || !Number.isFinite(positionIn) || positionIn < 0) throw new HttpError(400, 'position must be a number of seconds')
      const v = await watchable(user, videoId)
      if (v.status !== 'ready') throw new HttpError(409, 'this video is not ready yet')
      const position = Math.min(positionIn, v.duration ?? positionIn)
      const at = now()
      await watch.updateOne(
        { _id: `${user.id}:${videoId}` },
        { $set: { user: user.id, video: videoId, position: type === 'ended' ? 0 : position, completed: type === 'ended', updatedAt: at } },
        { upsert: true },
      )
      if (type !== 'progress') await events.insertOne({ video: videoId, user: user.id, type, position, at })
    },

    // where to continue from. A finished video, or one nearly at the start or end, starts over.
    async resume(userId: string, videoId: string, duration?: number) {
      const w = await watch.findOne({ _id: `${userId}:${videoId}` })
      if (!w || w.completed || w.position < 5) return 0
      if (duration && w.position > duration - 10) return 0
      return Math.floor(w.position)
    },

    // how far each person got in each of these videos, for the library page
    async positions(userId: string, videoIds: string[]) {
      const rows = await watch.find({ _id: { $in: videoIds.map((id) => `${userId}:${id}`) } }).toArray()
      return new Map(rows.map((w) => [w.video, { position: Math.floor(w.position), completed: w.completed }]))
    },

    // the playback route calls these
    started: (video: VideoDoc, user: SessionUser) => serverEvent(video, user, 'start'),
    refused: (video: VideoDoc, user: SessionUser) => serverEvent(video, user, 'denied'),
    async keyRequested(video: VideoDoc, user: SessionUser, group: number) {
      const w = await watch.findOne({ _id: `${user.id}:${video._id}` })
      const gap = groupStart(group) - (w?.position ?? 0) // a player that never reports a position counts as sitting at 0
      await serverEvent(video, user, gap > config.flags.aheadSeconds ? 'key_ahead' : 'key', { group, gap: Math.round(gap) })
    },

    async flags(owner: SessionUser) {
      const open = await flags.find({ owner: owner.id, status: 'open' }).sort({ lastAt: -1 }).limit(100).toArray()
      const titles = new Map((await videos.find({ _id: { $in: [...new Set(open.map((f) => f.video))] } }, { projection: { title: 1 } }).toArray()).map((v) => [v._id, v.title]))
      return open.map((f) => ({ id: f._id, video: f.video, title: titles.get(f.video), viewer: f.viewer, rule: f.rule, text: RULE_TEXT[f.rule], count: f.count, windowMinutes: f.windowMinutes, firstAt: f.firstAt, lastAt: f.lastAt, summary: f.summary }))
    },

    async dismiss(owner: SessionUser, flagId: string) {
      const r = await flags.updateOne({ _id: flagId, owner: owner.id }, { $set: { status: 'dismissed' } })
      if (!r.matchedCount) throw new HttpError(404, 'flag not found')
    },

    async overview(owner: SessionUser, videoId: string) {
      const v = await watchable(owner, videoId)
      if (v.owner !== owner.id) throw new HttpError(403, 'only the owner can see this')
      const starts = await events.aggregate<{ _id: string; starts: number }>([{ $match: { video: videoId, type: 'start' } }, { $group: { _id: '$user', starts: { $sum: 1 } } }]).toArray()
      const marks = await watch.find({ video: videoId }).toArray()
      const startsBy = new Map(starts.map((s) => [s._id, s.starts]))
      return {
        starts: starts.reduce((n, s) => n + s.starts, 0),
        watchers: marks.length,
        completed: marks.filter((m) => m.completed).length,
        // people are shown by what they last did, not by email: the owner already knows whom they invited
        recent: marks.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 20).map((m) => ({ position: Math.floor(m.position), completed: m.completed, lastSeen: m.updatedAt, starts: startsBy.get(m.user) ?? 0, you: m.user === owner.id })),
      }
    },

    async removeVideo(videoId: string) {
      await Promise.all([events.deleteMany({ video: videoId }), watch.deleteMany({ video: videoId }), flags.deleteMany({ video: videoId })])
    },

    // lets tests wait for summaries that were started in the background
    settle: () => Promise.allSettled([...pending]),
  }
}

export type AnalyticsService = ReturnType<typeof analyticsService>

// the four collections wired up the same way everywhere
export function makeAnalytics(db: Db, ai: Ai | null, now?: () => Date) {
  return analyticsService(db.collection<VideoDoc>('videos'), db.collection<WatchDoc>('watch'), db.collection<EventDoc>('events'), db.collection<FlagDoc>('flags'), ai, now)
}
