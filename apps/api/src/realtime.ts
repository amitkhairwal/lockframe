import type { Server as HttpServer } from 'node:http'
import { parseCookie } from 'cookie'
import { Redis } from 'ioredis'
import { Server } from 'socket.io'
import { readSession, SESSION_COOKIE } from './auth.js'
import { VIDEO_CHANNEL, type VideoEvent } from './redis.js'

// Socket.io on the same port. A user only ever joins their own room.
export function realtime(http: HttpServer, redisUrl?: string) {
  const io = new Server(http, { serveClient: false })

  io.use(async (socket, next) => {
    const user = await readSession(parseCookie(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE])
    if (!user) return next(new Error('login required'))
    socket.data.user = user
    next()
  })
  io.on('connection', (socket) => void socket.join(`user:${socket.data.user.id}`))

  const emit = ({ owner, ...video }: VideoEvent) => io.to(`user:${owner}`).emit('video', video)

  // workers publish state changes on Redis; relay them to the owner's browsers
  const sub = redisUrl ? new Redis(redisUrl) : undefined
  sub?.on('error', (err) => console.error('redis subscriber:', err.message))
  // subscribe on every (re)connect: a one-shot subscribe is lost if Redis was down when the API booted
  sub?.on('ready', () => sub.subscribe(VIDEO_CHANNEL).catch((err) => console.error('subscribe failed:', err.message)))
  sub?.on('message', (_channel, text) => {
    try {
      emit(JSON.parse(text) as VideoEvent)
    } catch {
      // a malformed message is not worth crashing the API for
    }
  })

  return {
    emit,
    async close() {
      sub?.disconnect()
      await io.close()
    },
  }
}
