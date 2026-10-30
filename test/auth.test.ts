import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { signSession } from '../apps/api/src/auth.js'
import { resetLimits } from '../apps/api/src/ratelimit.js'
import { harness, type Harness } from './harness.js'

let h: Harness
beforeAll(async () => {
  h = await harness()
})
afterAll(() => h.close())
beforeEach(() => resetLimits())

const auth = (path: string, json: unknown, extra: Record<string, string> = {}) =>
  fetch(h.api + path, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(json) })

describe('signup', () => {
  it('creates a user and sets a hardened session cookie', async () => {
    const res = await auth('/api/auth/signup', { email: 'Ann@Example.com ', password: 'long enough pw' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ email: 'ann@example.com' })
    const cookie = res.headers.getSetCookie()[0]!
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Path=\//)
  })

  it('stores a salted scrypt hash, never the password', async () => {
    await auth('/api/auth/signup', { email: 'hash@example.com', password: 'my secret phrase' })
    await auth('/api/auth/signup', { email: 'hash2@example.com', password: 'my secret phrase' })
    const [a, b] = await Promise.all(['hash@example.com', 'hash2@example.com'].map((email) => h.users.findOne({ email })))
    expect(a!.passwordHash).toMatch(/^scrypt:/)
    expect(a!.passwordHash).not.toContain('my secret phrase')
    expect(a!.passwordHash).not.toBe(b!.passwordHash) // same password, different salt
  })

  it('rejects bad email, short and oversized passwords', async () => {
    expect((await auth('/api/auth/signup', { email: 'nope', password: 'long enough pw' })).status).toBe(400)
    expect((await auth('/api/auth/signup', { email: 'x@example.com', password: 'short' })).status).toBe(400)
    expect((await auth('/api/auth/signup', { email: 'x@example.com', password: 'a'.repeat(129) })).status).toBe(400)
    expect((await auth('/api/auth/signup', { email: 'x@example.com' })).status).toBe(400)
  })

  it('rejects a duplicate email, case insensitive', async () => {
    await auth('/api/auth/signup', { email: 'dup@example.com', password: 'long enough pw' })
    const again = await auth('/api/auth/signup', { email: 'DUP@example.com', password: 'another long pw' })
    expect(again.status).toBe(409)
  })

  it('does not take form posts (no cross-site form can log anyone in or out)', async () => {
    const res = await fetch(h.api + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a@b.co&password=whatever12',
    })
    expect(res.status).toBe(415)
  })
})

describe('login and session', () => {
  it('logs in, and /me answers with the cookie', async () => {
    await auth('/api/auth/signup', { email: 'in@example.com', password: 'long enough pw' })
    const res = await auth('/api/auth/login', { email: 'IN@example.com', password: 'long enough pw' })
    expect(res.status).toBe(200)
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!
    const me = await h.call('/api/auth/me', { cookie })
    expect(await me.json()).toMatchObject({ email: 'in@example.com' })
  })

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await auth('/api/auth/signup', { email: 'same@example.com', password: 'long enough pw' })
    const wrong = await auth('/api/auth/login', { email: 'same@example.com', password: 'not the password' })
    const unknown = await auth('/api/auth/login', { email: 'ghost@example.com', password: 'not the password' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await wrong.json()).toEqual(await unknown.json())
  })

  it('refuses requests with no cookie', async () => {
    for (const path of ['/api/auth/me', '/api/videos']) expect((await h.call(path)).status).toBe(401)
    expect((await h.call('/api/uploads', { json: { filename: 'a.mp4', size: 5, contentType: 'video/mp4' } })).status).toBe(401)
  })

  it('refuses a tampered token', async () => {
    const token = await signSession({ id: 'u1', email: 'a@example.com' })
    const bad = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA')
    expect((await h.call('/api/auth/me', { cookie: `sv_session=${bad}` })).status).toBe(401)
  })

  it('refuses an expired token', async () => {
    const token = await signSession({ id: 'u1', email: 'a@example.com' }, -60)
    expect((await h.call('/api/auth/me', { cookie: `sv_session=${token}` })).status).toBe(401)
  })

  it('refuses a token signed with another secret', async () => {
    const forged = await new SignJWT({ email: 'a@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('x'.repeat(40)))
    expect((await h.call('/api/auth/me', { cookie: `sv_session=${forged}` })).status).toBe(401)
  })

  it('refuses an unsigned token (alg none)', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', email: 'a@example.com', exp: 9999999999 })}.`
    expect((await h.call('/api/auth/me', { cookie: `sv_session=${none}` })).status).toBe(401)
  })

  it('logout clears the cookie', async () => {
    const res = await h.call('/api/auth/logout', { method: 'POST' })
    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie()[0]).toMatch(/sv_session=;/)
  })
})

describe('rate limits', () => {
  it('limits auth attempts per address', async () => {
    const codes: number[] = []
    for (let i = 0; i < 12; i++) codes.push((await auth('/api/auth/login', { email: 'a@example.com', password: 'whatever pw' })).status)
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true)
    expect(codes.slice(10)).toEqual([429, 429])
  })

  it('does not believe X-Forwarded-For unless a proxy is configured', async () => {
    const codes: number[] = []
    for (let i = 0; i < 12; i++) {
      codes.push((await auth('/api/auth/login', { email: 'a@example.com', password: 'whatever pw' }, { 'x-forwarded-for': `10.0.0.${i}` })).status)
    }
    expect(codes.at(-1)).toBe(429)
  })

  it('limits upload creation per user, not per address', async () => {
    const a = await h.signup('rate-a@example.com')
    const b = await h.signup('rate-b@example.com')
    const create = (cookie: string) => h.call('/api/uploads', { json: { filename: 'a.mp4', size: 5, contentType: 'video/mp4' }, cookie })
    let last = 0
    for (let i = 0; i < 31; i++) last = (await create(a.cookie)).status
    expect(last).toBe(429)
    expect((await create(b.cookie)).status).toBe(201)
  })
})

describe('config', () => {
  const load = async (env: Record<string, string | undefined>) => {
    vi.resetModules()
    const saved = { ...process.env }
    Object.assign(process.env, env)
    for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k]
    try {
      return await import('../apps/api/src/config.js')
    } finally {
      process.env = saved
    }
  }

  it('refuses to start in production without a strong JWT_SECRET', async () => {
    for (const JWT_SECRET of [undefined, 'too short']) {
      const { config } = await load({ NODE_ENV: 'production', JWT_SECRET })
      expect(() => config.sessionSecret).toThrow(/JWT_SECRET/)
    }
  })

  it('marks the cookie Secure in production', async () => {
    const { config } = await load({ NODE_ENV: 'production', JWT_SECRET: 'p'.repeat(40) })
    expect(config.secureCookies).toBe(true)
  })
})
