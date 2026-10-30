import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { groqAi } from '../apps/api/src/ai.js'
import { config } from '../apps/api/src/config.js'
import type { Segment } from '../apps/api/src/transcript.js'
import { fakeAi } from '../test/fakeAi.js'
import { makeSource, makeStack, sleep, until, type Stack } from './stack.js'

let s: Stack
let ai: Awaited<ReturnType<typeof fakeAi>>
let alice: Awaited<ReturnType<Stack['signup']>>
let firstRun: typeof ai.calls = [] // beforeEach clears the fake's log, so keep what the first video sent
const src = join(process.env.TMP_DIR!, 'speech-src.mp4')

// 14 s of video cut into two audio pieces: 0 to 10 s and 8 to 14 s (2 s overlap)
const P0: Segment[] = [
  { start: 0, end: 4, text: 'Welcome to the talk on closures.' },
  { start: 4, end: 9, text: 'A closure remembers its variables.' },
  { start: 9, end: 10, text: 'Next we cover' }, // cut off at the end of the piece, and heard whole by the next one
]
const P1: Segment[] = [
  { start: 0, end: 1, text: 'remembers its variables.' }, // the overlap again: must not appear twice
  { start: 1, end: 5, text: 'Next we cover the event loop and promises.' },
]
const MERGED = ['Welcome to the talk on closures.', 'A closure remembers its variables.', 'Next we cover the event loop and promises.']

beforeAll(async () => {
  await mkdir(process.env.TMP_DIR!, { recursive: true })
  await makeSource(src, { seconds: 14, size: '640x360' })
  ai = await fakeAi()
  Object.assign(config.ai, { baseUrl: ai.url, key: 'gsk_test', pieceSeconds: 10, overlapSeconds: 2, attempts: 3, backoffMs: 200 })
  ai.script.chat = (m) => (m[0]!.content.startsWith('You name the topics') ? '{"chapters":[{"start":0,"title":"Closures and loops"}]}' : '{"keywords":["closure"]}')
  s = await makeStack({ ai: groqAi() })
  alice = await s.signup('alice@example.com')
})
afterAll(async () => {
  await s.close()
  await ai.close()
})
beforeEach(() => {
  ai.reset()
  ai.script.transcribe = (n) => (n === 0 ? P0 : P1)
})

const upload = async (name = 'talk.mp4') => (await s.send(alice, src, name)).id
const state = async (id: string) => (await s.videoCol.findOne({ _id: id }))!
const understood = (id: string, want: string, ms = 60_000) => until(async () => ((await state(id)).understanding === want ? await state(id) : undefined), ms)

describe('after ready', () => {
  let id: string

  it('lets people play at once and transcribes in the background', async () => {
    ai.script.delayMs = 1500 // keeps the job running while we look
    id = await upload()
    await s.waitFor(id, 'ready')
    expect(['pending', 'running']).toContain((await state(id)).understanding)
    const play = await s.call(`/api/videos/${id}/playback`, { cookie: alice.cookie, json: {} })
    expect(play.status).toBe(200)
    await s.call(`/api/videos/${id}/playback/stop`, { cookie: alice.cookie, json: { lease: ((await play.json()) as { lease: string }).lease } })
    expect((await s.call(`/api/videos/${id}/ask`, { cookie: alice.cookie, json: { question: 'What is a closure?' } })).status).toBe(409) // not ready yet
    await understood(id, 'done')
    firstRun = [...ai.calls]
  })

  it('sent real 16 kHz mono mp3 audio in two pieces, with the model and timestamp options', () => {
    const calls = firstRun.filter((c) => c.path === '/audio/transcriptions')
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.fields).toMatchObject({ model: 'whisper-large-v3-turbo', response_format: 'verbose_json' })
      expect(c.bytes!).toBeGreaterThan(5_000)
      expect(c.bytes!).toBeLessThan(200_000) // 10 s of 32 kbps audio is about 40 kB
    }
  })

  it('stores each sentence once across the overlap, with chunks and chapters', async () => {
    const t = (await s.store.get(id))!
    expect(t.segments!.map((x) => x.text)).toEqual(MERGED)
    expect(t.segments!.map((x) => x.start)).toEqual([0, 4, 9]) // piece 2 starts 8 s in, its second sentence starts 1 s after that
    expect(t.pieces).toBeUndefined() // working data removed once merged
    expect(t.chapters).toEqual([{ start: 0, title: 'Closures and loops' }])
    expect(await s.chunkCol.countDocuments({ videoId: id })).toBe(1)
  })

  it('serves captions, search and answers through the API', async () => {
    const info = await (await s.call(`/api/videos/${id}/understanding`, { cookie: alice.cookie })).json()
    expect(info).toMatchObject({ status: 'done', hasCaptions: true, chapters: [{ start: 0, title: 'Closures and loops' }] })
    const vtt = await (await s.call(`/api/videos/${id}/captions.vtt`, { cookie: alice.cookie })).text()
    expect(vtt).toContain('00:00:09.000 --> 00:00:13.000')
    const hits = await (await s.call(`/api/search?q=event%20loop&video=${id}`, { cookie: alice.cookie })).json()
    expect(hits[0]).toMatchObject({ start: 9, at: '0:09' })
    ai.script.chat = (m) => (m[0]!.content.startsWith('Turn a question') ? '{"keywords":["closure"]}' : '{"found":true,"answer":"It remembers its variables.","citations":[1]}')
    const answer = await (await s.call(`/api/videos/${id}/ask`, { cookie: alice.cookie, json: { question: 'How does a closure remember its variables?' } })).json()
    expect(answer).toMatchObject({ found: true, citations: [{ start: 4 }] })
  })
})

describe('failure and retry', () => {
  it('a failure on piece 2 keeps piece 1, leaves the video ready, and a retry does not pay for piece 1 again', async () => {
    const order: string[] = []
    ai.script.transcribe = (n) => {
      order.push(n === 0 ? 'piece0' : 'piece1')
      return n === 0 ? P0 : 500 // piece 1 always fails
    }
    const id = await upload('flaky.mp4')
    const failed = await understood(id, 'failed')
    expect(failed.status).toBe('ready') // playback never depended on it
    expect(failed.understandingError).toMatch(/provider said 500/)
    expect(order[0]).toBe('piece0')
    expect(order.filter((x) => x === 'piece0')).toHaveLength(1) // retried attempts skipped the finished piece
    expect(order.filter((x) => x === 'piece1').length).toBe(config.ai.attempts)
    expect(Object.keys((await s.store.pieces(id)) as object)).toEqual(['0'])

    ai.reset()
    ai.script.transcribe = (n) => {
      order.push(`again${n}`)
      return P1
    }
    order.length = 0
    expect((await s.call(`/api/videos/${id}/understanding/retry`, { cookie: alice.cookie, json: {} })).status).toBe(200)
    const done = await understood(id, 'done')
    expect(done.uRun).toBe(1)
    expect(order).toEqual(['again0']) // one provider call: only the missing piece
    expect((await s.store.get(id))!.segments!.map((x) => x.text)).toEqual(MERGED)
  })

  it('a rejected key is not retried', async () => {
    ai.script.transcribe = () => 401
    const id = await upload('badkey.mp4')
    const failed = await understood(id, 'failed')
    expect(ai.calls.filter((c) => c.path === '/audio/transcriptions')).toHaveLength(1)
    expect(failed.understandingError).toMatch(/provider said 401/)
    expect(failed.understandingError).not.toContain('gsk_test')
  })
})

describe('delete while transcribing', () => {
  it('leaves nothing behind', async () => {
    ai.script.delayMs = 2000
    const id = await upload('doomed.mp4')
    await understood(id, 'running')
    expect((await s.call(`/api/videos/${id}`, { cookie: alice.cookie, method: 'DELETE' })).status).toBe(204)
    await sleep(5000)
    expect(await s.chunkCol.countDocuments({ videoId: id })).toBe(0)
    expect(await s.store.get(id)).toBeNull()
    expect(await s.videoCol.countDocuments({ _id: id })).toBe(0)
  })
})

describe('no provider', () => {
  it('marks videos "off" and queues nothing', async () => {
    const prefix = config.queuePrefix
    config.queuePrefix = `${prefix}off` // its own queues, so the first stack's workers do not pick its jobs up
    const off = await makeStack({ ai: null })
    try {
      const who = await off.signup('solo@example.com')
      const id = (await off.send(who, src, 'plain.mp4')).id
      await off.waitFor(id, 'ready')
      await until(async () => (await off.videoCol.findOne({ _id: id }))?.understanding === 'off' || undefined, 10_000)
      expect((await off.queues.understand.getJobCounts('waiting', 'active', 'delayed')).waiting).toBe(0)
      expect((await off.call(`/api/search?q=anything`, { cookie: who.cookie })).status).toBe(503)
    } finally {
      await off.close()
      config.queuePrefix = prefix
    }
  })
})
