import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Collection } from 'mongodb'
import { jwtVerify, SignJWT } from 'jose'
import { config } from './config.js'
import { HttpError } from './uploads.js'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
export const SESSION_COOKIE = 'sv_session'
const KEY_LEN = 64
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/

export interface UserDoc {
  _id: string
  email: string
  passwordHash: string
  createdAt: Date
}

export interface SessionUser {
  id: string
  email: string
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, KEY_LEN)
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string) {
  const [alg, salt, hash] = stored.split(':')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length)
  return timingSafeEqual(actual, expected)
}

const secretKey = () => new TextEncoder().encode(config.sessionSecret)

export function signSession(user: SessionUser, ttlSeconds = config.sessionDays * 86400) {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey())
}

export async function readSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] })
    return payload.sub && typeof payload.email === 'string' ? { id: payload.sub, email: payload.email } : null
  } catch {
    return null
  }
}

export const normalizeEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '')
export const isEmail = (e: string) => e.length <= 254 && EMAIL.test(e)

// a real hash to compare against when the email is unknown, so timing does not give it away
const decoy = hashPassword('decoy-password')

export function authService(users: Collection<UserDoc>) {
  return {
    async signup(emailIn: unknown, password: unknown): Promise<SessionUser> {
      const email = normalizeEmail(emailIn)
      if (!isEmail(email)) throw new HttpError(400, 'enter a valid email')
      // 128 cap: scrypt cost grows with input, so keep it bounded
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        throw new HttpError(400, 'password must be 8 to 128 characters')
      }
      const doc: UserDoc = { _id: randomUUID(), email, passwordHash: await hashPassword(password), createdAt: new Date() }
      try {
        await users.insertOne(doc)
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new HttpError(409, 'email already registered')
        throw err
      }
      return { id: doc._id, email }
    },

    async login(emailIn: unknown, password: unknown): Promise<SessionUser> {
      const email = normalizeEmail(emailIn)
      const user = typeof password === 'string' && password.length <= 128 ? await users.findOne({ email }) : null
      const ok = await verifyPassword(typeof password === 'string' ? password.slice(0, 128) : '', user?.passwordHash ?? (await decoy))
      if (!user || !ok) throw new HttpError(401, 'invalid email or password')
      return { id: user._id, email: user.email }
    },
  }
}

export type AuthService = ReturnType<typeof authService>
