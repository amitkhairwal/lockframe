import { jwtVerify, SignJWT } from 'jose'
import type { Collection } from 'mongodb'
import type { SessionUser } from './auth.js'
import { config } from './config.js'
import type { AnalyticsService } from './analytics.js'
import type { KeyStore } from './keys.js'
import type { Lease } from './lease.js'
import { HttpError } from './uploads.js'
import { canAccess, type VideoDoc } from './videos.js'

const AUDIENCE = 'playback' // a playback token is never accepted as a login session, and the reverse
const secretKey = () => new TextEncoder().encode(config.sessionSecret)

interface Claims {
  user: string
  email: string
  video: string
  lease: string
}

export function playbackService(videos: Collection<VideoDoc>, keys: KeyStore, lease: Lease, analytics?: AnalyticsService) {
  const slot = (user: string, video: string) => `${user}:${video}`
  const canWatch = canAccess

  async function watchable(user: SessionUser, id: string) {
    const v = await videos.findOne({ _id: id })
    // a stranger gets the same answer as a missing video
    if (!v || !canWatch(v, user)) throw new HttpError(404, 'video not found')
    if (v.status !== 'ready') throw new HttpError(409, 'this video is not ready yet')
    return v
  }

  return {
    // Needs the login session. Called to start and again before each token runs out.
    async start(user: SessionUser, videoId: string, mine?: unknown) {
      const v = await watchable(user, videoId)
      const id = await lease.acquire(slot(user.id, videoId), config.playback.leaseSeconds, typeof mine === 'string' ? mine : undefined)
      if (!id) {
        await analytics?.refused(v, user)
        throw new HttpError(409, 'this video is playing on another device')
      }
      const fresh = id !== mine // a refresh with the same lease is not a new viewing
      if (fresh) await analytics?.started(v, user)
      const token = await new SignJWT({ user: user.id, email: user.email, video: videoId, lease: id } satisfies Claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${config.playback.tokenSeconds}s`)
        .sign(secretKey())
      return {
        token,
        expiresIn: config.playback.tokenSeconds,
        lease: id,
        master: `${config.hls.mediaBase}/${videoId}/master.m3u8`,
        viewer: user.email,
        duration: v.duration,
        resume: analytics ? await analytics.resume(user.id, videoId, v.duration) : 0,
      }
    },

    async stop(user: SessionUser, videoId: string, id: unknown) {
      if (typeof id === 'string') await lease.release(slot(user.id, videoId), id)
    },

    // The key route. Needs only the token, never the cookie, so a page on another site
    // cannot get keys by riding the session. Every check runs on every request.
    async key(authorization: string | undefined, videoId: string, group: number) {
      const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]
      if (!token) throw new HttpError(401, 'playback token required')
      let claims: Claims
      try {
        const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'], audience: AUDIENCE })
        claims = payload as unknown as Claims
      } catch {
        throw new HttpError(401, 'playback token invalid or expired')
      }
      if (claims.video !== videoId) throw new HttpError(403, 'token is for another video')
      if (!Number.isInteger(group) || group < 0) throw new HttpError(400, 'bad key number')

      // access can be withdrawn while a token is still alive
      const v = await videos.findOne({ _id: videoId, status: 'ready' })
      if (!v || !canWatch(v, { id: claims.user, email: claims.email })) throw new HttpError(403, 'no access')
      if (!(await lease.hold(slot(claims.user, videoId), claims.lease, config.playback.leaseSeconds))) {
        throw new HttpError(403, 'this video is playing on another device')
      }
      const key = await keys.get(videoId, group)
      if (!key) throw new HttpError(404, 'no such key')
      await analytics?.keyRequested(v, { id: claims.user, email: claims.email }, group)
      return key
    },
  }
}

export type PlaybackService = ReturnType<typeof playbackService>
