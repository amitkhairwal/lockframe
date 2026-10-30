import { describe, expect, it } from 'vitest'
import { config } from '../apps/api/src/config.js'
import { evaluate, groupStart, type Ev, type EventType } from '../apps/api/src/rules.js'

const now = new Date('2026-01-01T12:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)
const sec = 1000
const min = 60 * sec
const many = (type: EventType, n: number, spread: number, from = 0): Ev[] => Array.from({ length: n }, (_, i) => ({ type, at: ago(from + (i * spread) / Math.max(n, 1)) }))
const t = config.flags

describe('evaluate', () => {
  it('says nothing for an ordinary session', () => {
    const session: Ev[] = [{ type: 'start', at: ago(20 * min) }, { type: 'play', at: ago(20 * min) }, ...many('key', 8, 20 * min), { type: 'pause', at: ago(5 * min) }, { type: 'seek', at: ago(4 * min) }, { type: 'ended', at: ago(1 * min) }]
    expect(evaluate(session, now)).toEqual([])
  })

  it.each([
    ['many_devices', 'denied', t.deviceDenials, t.deviceWindowMin * min],
    ['repeat_replays', 'start', t.replayStarts, t.replayWindowMin * min],
    ['key_ahead', 'key_ahead', t.aheadCount, t.aheadWindowMin * min],
  ] as const)('%s fires at its threshold and not one below', (rule, type, need, window) => {
    expect(evaluate(many(type, need - 1, window - 1000), now).map((h) => h.rule)).not.toContain(rule)
    const hit = evaluate(many(type, need, window - 1000), now).find((h) => h.rule === rule)
    expect(hit).toMatchObject({ rule, count: need })
  })

  it('ignores events outside the window', () => {
    expect(evaluate(many('denied', t.deviceDenials, 1000, t.deviceWindowMin * min + 5000), now)).toEqual([])
    expect(evaluate(many('start', t.replayStarts, 1000, t.replayWindowMin * min + 5000), now)).toEqual([])
  })

  it('ignores events from the future', () => {
    expect(evaluate(many('denied', t.deviceDenials, 1000, -5 * min), now)).toEqual([])
  })

  it('counts a burst of keys, whether or not they were ahead of the playhead', () => {
    const half = Math.floor(t.burstKeys / 2)
    const events = [...many('key', half, 30 * sec), ...many('key_ahead', t.burstKeys - half, 30 * sec)]
    expect(evaluate(events, now).map((h) => h.rule)).toContain('key_burst')
    expect(evaluate(events.slice(1), now).map((h) => h.rule)).not.toContain('key_burst')
    expect(evaluate(many('key', t.burstKeys, 10 * min), now).map((h) => h.rule)).not.toContain('key_burst') // same keys, spread over 10 minutes: normal seeking
  })

  it('can fire several rules at once and reports the window', () => {
    const hits = evaluate([...many('denied', 5, min), ...many('start', 8, 30 * min)], now)
    expect(hits.map((h) => h.rule).sort()).toEqual(['many_devices', 'repeat_replays'])
    expect(hits.find((h) => h.rule === 'many_devices')).toMatchObject({ count: 5, windowMinutes: t.deviceWindowMin })
  })
})

describe('groupStart', () => {
  it('is the media time where a key group begins', () => {
    expect(groupStart(0, 5, 6)).toBe(0)
    expect(groupStart(1, 5, 6)).toBe(30)
    expect(groupStart(4, 5, 6)).toBe(120)
    expect(groupStart(2, 1, 6)).toBe(12)
  })
})
