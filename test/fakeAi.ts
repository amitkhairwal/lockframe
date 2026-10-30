import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Segment } from '../apps/api/src/transcript.js'

// Speaks the same HTTP shape as Groq's OpenAI compatible API. Tests script what it answers.
export async function fakeAi() {
  const calls: { path: string; auth?: string; fields?: Record<string, string>; json?: any; bytes?: number }[] = []
  const script = {
    // piece number (0 based, in call order) to its segments; return an Error status number to fail
    transcribe: (_n: number, _bytes: number): Segment[] | number => [],
    chat: (_messages: { role: string; content: string }[]): string | number => '{}',
    retryAfter: undefined as number | undefined,
    delayMs: 0,
  }
  let transcribed = 0

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const entry: (typeof calls)[number] = { path: req.url!, auth: req.headers.authorization }
    calls.push(entry)
    const fail = (status: number) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(script.retryAfter ? { 'retry-after': String(script.retryAfter) } : {}) })
      res.end(JSON.stringify({ error: { message: `scripted ${status} for key ${req.headers.authorization?.slice(7)}` } }))
    }

    if (req.url === '/audio/transcriptions') {
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body }).formData()
      entry.fields = {}
      form.forEach((v, k) => typeof v === "string" && (entry.fields![k] = v))
      entry.bytes = (form.get('file') as File).size
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs))
      const out = script.transcribe(transcribed++, entry.bytes)
      if (typeof out === 'number') return fail(out)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: out.map((s) => s.text).join(' '), segments: out }))
    } else if (req.url === '/chat/completions') {
      entry.json = JSON.parse(body.toString())
      const out = script.chat(entry.json.messages)
      if (typeof out === 'number') return fail(out)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: out } }] }))
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    script,
    reset() {
      calls.length = 0
      transcribed = 0
      script.delayMs = 0
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
