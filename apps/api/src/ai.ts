import { config } from './config.js'
import type { Segment } from './transcript.js'

export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

// The two things we need from a provider. Anything OpenAI compatible fits.
export interface Ai {
  transcribe(audio: Buffer, filename: string): Promise<Segment[]>
  chat(messages: ChatMessage[], o?: { json?: boolean }): Promise<string>
}

export const aiConfigured = () => config.ai.key.length > 0

async function send(path: string, init: RequestInit, timeoutMs: number) {
  let res: Response
  try {
    res = await fetch(config.ai.baseUrl + path, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${config.ai.key}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // the url carries no secret, the header is not part of the error
    throw new AiError(`provider unreachable: ${(err as Error).name}`, 0, true)
  }
  if (res.ok) return res
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
  const detail = String(body.error?.message ?? res.statusText).replaceAll(config.ai.key, '[key]').slice(0, 200)
  const wait = Number(res.headers.get('retry-after'))
  const retryable = res.status === 429 || res.status >= 500
  throw new AiError(`provider said ${res.status}: ${detail}`, res.status, retryable, Number.isFinite(wait) && wait > 0 ? wait * 1000 : undefined)
}

export function groqAi(): Ai {
  return {
    async transcribe(audio, filename) {
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(audio)]), filename)
      form.set('model', config.ai.sttModel)
      form.set('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'segment')
      form.set('temperature', '0')
      const res = await send('/audio/transcriptions', { method: 'POST', body: form }, 180_000)
      const out = (await res.json()) as { segments?: { start: number; end: number; text: string }[] }
      return (out.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }))
    },

    async chat(messages, o = {}) {
      const res = await send(
        '/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: config.ai.llmModel, messages, temperature: 0, ...(o.json ? { response_format: { type: 'json_object' } } : {}) }),
        },
        60_000,
      )
      const out = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      return out.choices?.[0]?.message?.content ?? ''
    },
  }
}
