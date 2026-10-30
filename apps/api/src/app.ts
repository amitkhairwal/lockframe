import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import cookie from '@fastify/cookie'
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify'
import { readSession, SESSION_COOKIE as COOKIE, signSession, type AuthService, type SessionUser } from './auth.js'
import { config } from './config.js'
import { allow } from './ratelimit.js'
import { HttpError, type UploadService } from './uploads.js'
import type { AnalyticsService } from './analytics.js'
import type { UnderstandService } from './understand.js'
import type { PlaybackService } from './playback.js'
import type { Storage } from './storage.js'
import type { VideoService } from './videos.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser
  }
}

const AUTH_PER_MIN = 10
const UPLOADS_PER_MIN = 30
const SEARCHES_PER_MIN = 60
const EVENTS_PER_MIN = 120 // progress pings every 10 s plus a few discrete events

export function buildApp(deps: { uploads: UploadService; auth: AuthService; videos: VideoService; playback: PlaybackService; storage: Storage; understand: UnderstandService; analytics: AnalyticsService }) {
  const { uploads, auth, videos, playback, storage, understand, analytics } = deps
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    // trust only the last N hops, so a client cannot spoof its address with its own header
    trustProxy: config.trustProxy > 0 ? (_addr: string, hop: number) => hop < config.trustProxy : false,
  })
  app.register(cookie)

  app.setErrorHandler((err: FastifyError | HttpError, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message })
    // body parser and validation errors carry their own 4xx status
    if ('statusCode' in err && err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message })
    app.log.error(err)
    if (process.env.DEBUG_ERRORS) console.error(err)
    return reply.code(500).send({ error: 'internal error' })
  })

  async function requireUser(req: FastifyRequest) {
    const user = await readSession(req.cookies[COOKIE])
    if (!user) throw new HttpError(401, 'login required')
    req.user = user
  }

  const limit = (key: string, max: number) => {
    if (!allow(key, max, 60_000)) throw new HttpError(429, 'too many requests, try again in a minute')
  }

  async function startSession(reply: FastifyReply, user: SessionUser) {
    reply.setCookie(COOKIE, await signSession(user), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      path: '/',
      maxAge: config.sessionDays * 86400,
    })
    return user
  }

  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>
  const authed = { preHandler: requireUser }
  const me = (req: FastifyRequest) => req.user!

  app.get('/healthz', async () => ({ ok: true })) // no DB, so uptime pings cost nothing

  app.post('/api/auth/signup', async (req, reply) => {
    limit(`auth:${req.ip}`, AUTH_PER_MIN)
    const user = await auth.signup(body(req).email, body(req).password)
    return reply.code(201).send(await startSession(reply, user))
  })

  app.post('/api/auth/login', async (req, reply) => {
    limit(`auth:${req.ip}`, AUTH_PER_MIN)
    const user = await auth.login(body(req).email, body(req).password)
    return startSession(reply, user)
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/auth/me', authed, async (req) => me(req))

  app.post('/api/uploads', authed, async (req, reply) => {
    limit(`upload:${me(req).id}`, UPLOADS_PER_MIN)
    reply.code(201)
    return uploads.create(me(req).id, { filename: body(req).filename, size: body(req).size, contentType: body(req).contentType })
  })

  app.get<{ Params: { id: string } }>('/api/uploads/:id/parts', authed, (req) => uploads.parts(me(req).id, req.params.id))

  app.post<{ Params: { id: string; n: string } }>('/api/uploads/:id/parts/:n/url', authed, (req) =>
    uploads.signPart(me(req).id, req.params.id, Number(req.params.n), body(req).sha256),
  )

  app.post<{ Params: { id: string } }>('/api/uploads/:id/complete', authed, (req) => uploads.complete(me(req).id, req.params.id))

  app.delete<{ Params: { id: string } }>('/api/uploads/:id', authed, async (req, reply) => {
    await uploads.abort(me(req).id, req.params.id)
    return reply.code(204).send()
  })

  app.get('/api/videos', authed, async (req) => {
    const user = me(req)
    const rows = await videos.list(user)
    const seen = await analytics.positions(user.id, rows.map((r) => r.id))
    return rows.map((r) => ({ ...r, ...seen.get(r.id) }))
  })
  app.get<{ Params: { id: string } }>('/api/videos/:id', authed, (req) => videos.get(me(req), req.params.id))

  app.delete<{ Params: { id: string } }>('/api/videos/:id', authed, async (req, reply) => {
    await videos.remove(me(req), req.params.id)
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>('/api/videos/:id/retry', authed, (req) => videos.retry(me(req), req.params.id))

  app.post<{ Params: { id: string } }>('/api/videos/:id/viewers', authed, (req) => videos.invite(me(req), req.params.id, body(req).email))

  app.delete<{ Params: { id: string; email: string } }>('/api/videos/:id/viewers/:email', authed, async (req, reply) => {
    await videos.uninvite(me(req), req.params.id, req.params.email)
    return reply.code(204).send()
  })

  app.get<{ Params: { id: string } }>('/api/videos/:id/understanding', authed, (req) => understand.info(me(req), req.params.id))
  app.post<{ Params: { id: string } }>('/api/videos/:id/understanding/retry', authed, (req) => understand.retry(me(req), req.params.id))
  app.get<{ Params: { id: string } }>('/api/videos/:id/captions.vtt', authed, async (req, reply) => {
    return reply.header('content-type', 'text/vtt; charset=utf-8').send(await understand.captions(me(req), req.params.id))
  })
  app.get<{ Querystring: { q?: string; video?: string } }>('/api/search', authed, (req) => {
    limit(`search:${me(req).id}`, SEARCHES_PER_MIN)
    return understand.search(me(req), req.query.q, req.query.video)
  })
  app.post<{ Params: { id: string } }>('/api/videos/:id/ask', authed, (req) => {
    limit(`ask:${me(req).id}`, config.ai.asksPerMinute) // each question can cost two model calls
    return understand.ask(me(req), req.params.id, body(req).question)
  })

  app.post<{ Params: { id: string } }>('/api/videos/:id/events', authed, async (req, reply) => {
    limit(`events:${me(req).id}`, EVENTS_PER_MIN)
    await analytics.record(me(req), req.params.id, body(req).type, body(req).position)
    return reply.code(204).send()
  })
  app.get<{ Params: { id: string } }>('/api/videos/:id/analytics', authed, (req) => analytics.overview(me(req), req.params.id))
  app.get('/api/flags', authed, (req) => analytics.flags(me(req)))
  app.post<{ Params: { id: string } }>('/api/flags/:id/dismiss', authed, async (req, reply) => {
    await analytics.dismiss(me(req), req.params.id)
    return reply.code(204).send()
  })

  // playback: the session starts it and refreshes it, the token alone fetches keys
  app.post<{ Params: { id: string } }>('/api/videos/:id/playback', authed, (req) => playback.start(me(req), req.params.id, body(req).lease))

  app.post<{ Params: { id: string } }>('/api/videos/:id/playback/stop', authed, async (req, reply) => {
    await playback.stop(me(req), req.params.id, body(req).lease)
    return reply.code(204).send()
  })

  // the key goes to a player on another origin when media is on a CDN, so allow our own origins
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/keys/')) return
    const origin = req.headers.origin
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin).header('vary', 'origin')
      reply.header('access-control-allow-headers', 'authorization').header('access-control-allow-methods', 'GET')
    }
    if (req.method === 'OPTIONS') return reply.code(204).send()
  })

  app.get<{ Params: { id: string; group: string } }>('/api/keys/:id/:group', async (req, reply) => {
    // keyed by address: the token has not been checked yet, and a flood of bad tokens is cheap to stop here
    limit(`keys:${req.ip}`, config.keysPerMinute) // 600 by default: a 2 hour video rotates 240 times and a few tabs may be open
    const key = await playback.key(req.headers.authorization, req.params.id, Number(req.params.group))
    return reply.header('content-type', 'application/octet-stream').header('cache-control', 'no-store').send(key)
  })

  // the library still: only for people who may watch the video, because it is not encrypted
  app.get<{ Params: { id: string } }>('/api/videos/:id/thumb', authed, async (req, reply) => {
    await videos.get(me(req), req.params.id)
    const obj = await storage.get(`thumbs/${req.params.id}.jpg`)
    if (!obj) throw new HttpError(404, 'not found')
    reply.header('content-type', 'image/jpeg')
    reply.header('cache-control', 'private, max-age=3600')
    if (obj.length !== undefined) reply.header('content-length', obj.length)
    return reply.send(obj.body)
  })

  // Dev stand-in for a CDN. Everything under hls/ is encrypted, so it needs no login.
  const MEDIA = /^[\w-]+\/(master\.m3u8|\d+\/(index\.m3u8|seg_\d+\.ts))$/
  app.get<{ Params: { '*': string } }>('/media/*', async (req, reply) => {
    const path = req.params['*']
    if (!MEDIA.test(path)) throw new HttpError(404, 'not found')
    const obj = await storage.get(`hls/${path}`)
    if (!obj) throw new HttpError(404, 'not found')
    reply.header('content-type', path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
    reply.header('cache-control', path.endsWith('.ts') ? 'public, max-age=3600' : 'no-cache')
    if (obj.length !== undefined) reply.header('content-length', obj.length)
    return reply.send(obj.body)
  })

  // the built player: real files first, index.html for any other page route
  const webRoot = resolve(config.webDir)
  const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' }
  app.setNotFoundHandler(async (req, reply) => {
    const api = /^\/(api|media|socket\.io)(\/|$)/.test(req.url)
    if (api || req.method !== 'GET' || !existsSync(join(webRoot, 'index.html'))) return reply.code(404).send({ error: 'not found' })
    const file = join(webRoot, normalize(decodeURIComponent(req.url.split('?')[0]!)))
    const isFile = file.startsWith(webRoot + '/') && existsSync(file) && extname(file) !== ''
    reply.header('content-type', TYPES[extname(file)] ?? 'text/html; charset=utf-8')
    reply.header('cache-control', isFile && file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    return reply.send(await readFile(isFile ? file : join(webRoot, 'index.html')))
  })

  return app
}
