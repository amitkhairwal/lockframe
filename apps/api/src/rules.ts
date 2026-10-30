import { config } from './config.js'

export type EventType = 'start' | 'denied' | 'key' | 'key_ahead' | 'play' | 'pause' | 'seek' | 'ended'
export type Rule = 'many_devices' | 'repeat_replays' | 'key_ahead' | 'key_burst'

export interface Ev {
  type: EventType
  at: Date
}

export interface Hit {
  rule: Rule
  count: number
  windowMinutes: number
}

export const RULE_TEXT: Record<Rule, string> = {
  many_devices: 'Tried to play on a second device several times while the first was active',
  repeat_replays: 'Started the same video many times in a short while',
  key_ahead: 'Requested decryption keys far ahead of where the video was playing',
  key_burst: 'Requested decryption keys much faster than playback needs',
}

const within = (events: Ev[], type: EventType, now: Date, ms: number) => events.filter((e) => e.type === type && now.getTime() - e.at.getTime() <= ms && e.at <= now).length

// One viewer, one video, their recent events. Pure, so every threshold can be tested.
export function evaluate(events: Ev[], now: Date, t = config.flags): Hit[] {
  const min = 60_000
  const hits: Hit[] = []
  const add = (rule: Rule, count: number, need: number, windowMinutes: number) => count >= need && hits.push({ rule, count, windowMinutes })
  add('many_devices', within(events, 'denied', now, t.deviceWindowMin * min), t.deviceDenials, t.deviceWindowMin)
  add('repeat_replays', within(events, 'start', now, t.replayWindowMin * min), t.replayStarts, t.replayWindowMin)
  add('key_ahead', within(events, 'key_ahead', now, t.aheadWindowMin * min), t.aheadCount, t.aheadWindowMin)
  add('key_burst', within(events, 'key', now, t.burstSeconds * 1000) + within(events, 'key_ahead', now, t.burstSeconds * 1000), t.burstKeys, t.burstSeconds / 60)
  return hits
}

// seconds of media a key group covers: segmentsPerKey segments of 6 s
export const groupStart = (group: number, segmentsPerKey = config.hls.segmentsPerKey, segmentSeconds = 6) => group * segmentsPerKey * segmentSeconds
