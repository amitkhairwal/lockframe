import { spawn } from 'node:child_process'
import { config } from '../../api/src/config.js'
import { InvalidMedia, encodeArgs, parseProbe, parseProgress, probeArgs, type Rung, type Source } from './media.js'

export class Aborted extends Error {
  override name = 'Aborted'
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

// Runs a binary without a shell. Streams stdout lines to onLine, kills the child on abort.
function run(bin: string, args: string[], opts: { signal?: AbortSignal; onLine?: (line: string) => void } = {}) {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let pending = ''

    const onAbort = () => child.kill('SIGKILL')
    if (opts.signal?.aborted) onAbort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (!opts.onLine) return void (stdout += text)
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      lines.forEach(opts.onLine)
    })
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)))
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Aborted('stopped'))
      resolve({ code, stdout, stderr })
    })
  })
}

// the input is often a presigned url: keep its signature out of logs and job errors
const scrub = (text: string, secret: string) => (secret ? text.split(secret).join('<input>') : text)

export async function probe(input: string, signal?: AbortSignal): Promise<Source> {
  const r = await run(config.media.ffprobe, probeArgs(input), { signal })
  if (r.code !== 0) {
    // ffprobe cannot read it at all: treat as not a video rather than retrying forever
    if (/Invalid data found|moov atom not found|could not find codec/i.test(r.stderr)) {
      throw new InvalidMedia('this file could not be read as a video')
    }
    throw new Error(`ffprobe exited ${r.code}: ${scrub(r.stderr, input).trim().slice(-300)}`)
  }
  return parseProbe(JSON.parse(r.stdout), config.media.maxDurationSeconds)
}

export async function encodeRung(o: {
  input: string
  outDir: string
  rung: Rung
  source: Pick<Source, 'duration' | 'height'> & { hasAudio: boolean }
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}) {
  const args = encodeArgs({ input: o.input, outDir: o.outDir, rung: o.rung, hasAudio: o.source.hasAudio, threads: config.media.threads })
  const r = await run(config.media.ffmpeg, args, {
    signal: o.signal,
    onLine: (line) => {
      const p = parseProgress(line, o.source.duration)
      if (p !== null) o.onProgress?.(p)
    },
  })
  if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}: ${scrub(r.stderr, o.input).trim().slice(-300)}`)
}

// one still for the library card; 640 wide is plenty for a grid tile
export async function grabFrame(o: { input: string; outPath: string; at: number; signal?: AbortSignal }) {
  const args = ['-v', 'error', '-y', '-ss', String(o.at), '-i', o.input, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', o.outPath]
  const r = await run(config.media.ffmpeg, args, { signal: o.signal })
  if (r.code !== 0) throw new Error(`frame grab exited ${r.code}: ${scrub(r.stderr, o.input).trim().slice(-300)}`)
}

// 16 kHz mono mp3 at 32 kbps: speech stays clear and 10 minutes is about 2.4 MB
export async function extractAudio(o: { input: string; outPath: string; start: number; length: number; signal?: AbortSignal }) {
  const args = ['-v', 'error', '-y', '-ss', String(o.start), '-t', String(o.length), '-i', o.input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', o.outPath]
  const r = await run(config.media.ffmpeg, args, { signal: o.signal })
  if (r.code !== 0) throw new Error(`audio extract exited ${r.code}: ${scrub(r.stderr, o.input).trim().slice(-300)}`)
}
