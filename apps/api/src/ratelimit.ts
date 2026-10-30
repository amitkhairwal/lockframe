// Fixed-window counter kept in memory. One instance only: with several API
// instances each would count on its own (move to Redis when that matters).
const hits = new Map<string, { count: number; resetAt: number }>()

export function allow(key: string, max: number, windowMs: number, now = Date.now()) {
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
  const h = hits.get(key)
  if (!h || h.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  return ++h.count <= max
}

export const resetLimits = () => hits.clear()
