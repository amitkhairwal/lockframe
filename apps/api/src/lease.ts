import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'

// One playback slot per key (user + video). The holder id is minted here, never by the client,
// so a second device cannot claim the slot by guessing an id.
export interface Lease {
  // free slot or yours (pass your id to refresh it): the holder id; someone else's: null
  acquire(key: string, ttlSeconds: number, mine?: string): Promise<string | null>
  // true and extends the slot when `id` holds it
  hold(key: string, id: string, ttlSeconds: number): Promise<boolean>
  release(key: string, id: string): Promise<void>
}

export function memoryLease(now: () => number = Date.now): Lease {
  const slots = new Map<string, { id: string; until: number }>()
  const live = (key: string) => {
    const s = slots.get(key)
    return s && s.until > now() ? s : undefined
  }
  return {
    async acquire(key, ttl, mine) {
      const s = live(key)
      if (s && s.id !== mine) return null
      const id = s?.id ?? randomUUID()
      slots.set(key, { id, until: now() + ttl * 1000 })
      return id
    },
    async hold(key, id, ttl) {
      const s = live(key)
      if (!s || s.id !== id) return false
      s.until = now() + ttl * 1000
      return true
    },
    async release(key, id) {
      if (live(key)?.id === id) slots.delete(key)
    },
  }
}

const ACQUIRE = `
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[2] then return nil end
local id = cur or ARGV[3]
redis.call('SET', KEYS[1], id, 'EX', ARGV[1])
return id`
const HOLD = `
if redis.call('GET', KEYS[1]) == ARGV[2] then redis.call('EXPIRE', KEYS[1], ARGV[1]) return 1 end
return 0`
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

// Lua scripts, so check and change are one step. Redis expires the slot by itself.
export function redisLease(redis: Redis, prefix = 'sv:lease'): Lease {
  const k = (key: string) => `${prefix}:${key}`
  return {
    async acquire(key, ttl, mine) {
      return (await redis.eval(ACQUIRE, 1, k(key), ttl, mine ?? '', randomUUID())) as string | null
    },
    async hold(key, id, ttl) {
      return (await redis.eval(HOLD, 1, k(key), ttl, id)) === 1
    },
    async release(key, id) {
      await redis.eval(RELEASE, 1, k(key), id)
    },
  }
}
