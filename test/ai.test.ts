import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiError, groqAi } from '../apps/api/src/ai.js'
import { config } from '../apps/api/src/config.js'
import { fakeAi } from './fakeAi.js'

let fake: Awaited<ReturnType<typeof fakeAi>>
const KEY = 'gsk_test_secret_key_123'
beforeAll(async () => {
  fake = await fakeAi()
  config.ai.baseUrl = fake.url
  config.ai.key = KEY
})
afterAll(() => fake.close())

describe('groq client', () => {
  it('sends the key, the model and the timestamp options, and reads segments', async () => {
    fake.reset()
    fake.script.transcribe = () => [{ start: 0, end: 2.5, text: ' hello there' }, { start: 2.5, end: 5, text: ' second one' }]
    const out = await groqAi().transcribe(Buffer.from('fake audio'), 'p0.mp3')
    expect(out).toEqual([{ start: 0, end: 2.5, text: ' hello there' }, { start: 2.5, end: 5, text: ' second one' }])
    const call = fake.calls[0]!
    expect(call.auth).toBe(`Bearer ${KEY}`)
    expect(call.fields).toMatchObject({ model: 'whisper-large-v3-turbo', response_format: 'verbose_json', temperature: '0' })
    expect(call.bytes).toBe(10)
  })

  it('sends chat messages as json mode when asked and returns the text', async () => {
    fake.reset()
    fake.script.chat = () => '{"ok":true}'
    const text = await groqAi().chat([{ role: 'user', content: 'hi' }], { json: true })
    expect(text).toBe('{"ok":true}')
    expect(fake.calls[0]!.json).toMatchObject({ model: 'openai/gpt-oss-120b', temperature: 0, response_format: { type: 'json_object' } })
  })

  it('makes 429 retryable with the wait the provider asked for', async () => {
    fake.script.transcribe = () => 429
    fake.script.retryAfter = 7
    const err = await groqAi().transcribe(Buffer.from('x'), 'p.mp3').catch((e) => e)
    expect(err).toBeInstanceOf(AiError)
    expect(err).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 })
    fake.script.retryAfter = undefined
  })

  it('does not retry a bad key or a bad request, and retries a server error', async () => {
    for (const [status, retryable] of [[401, false], [400, false], [413, false], [500, true], [503, true]] as const) {
      fake.script.chat = () => status
      expect(await groqAi().chat([{ role: 'user', content: 'x' }]).catch((e) => e)).toMatchObject({ status, retryable })
    }
  })

  it('never puts the key in an error, even when the provider echoes it', async () => {
    fake.script.chat = () => 401 // the fake echoes the bearer value in its message
    const err = await groqAi().chat([{ role: 'user', content: 'x' }]).catch((e) => e)
    expect(err.message).not.toContain(KEY)
    expect(err.message).toContain('[key]')
  })

  it('treats an unreachable provider as retryable', async () => {
    const was = config.ai.baseUrl
    config.ai.baseUrl = 'http://127.0.0.1:1'
    expect(await groqAi().chat([{ role: 'user', content: 'x' }]).catch((e) => e)).toMatchObject({ status: 0, retryable: true })
    config.ai.baseUrl = was
  })
})
