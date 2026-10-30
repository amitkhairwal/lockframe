// Resumable multipart uploader. Runs in the browser and in Node 22.

export interface KV {
  get(key: string): string | null | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

export interface UploadOptions {
  api: string
  concurrency?: number
  retries?: number
  backoffMs?: number
  store?: KV
  headers?: Record<string, string> // extra headers for API calls only, e.g. a Cookie in Node
  onProgress?: (doneBytes: number, totalBytes: number) => void
  signal?: AbortSignal
}

export type FileLike = Blob & { name: string; lastModified?: number }

interface Plan {
  id: string
  partBytes: number
  partCount: number
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function api<T>(base: string, path: string, init?: RequestInit, extra?: Record<string, string>): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...extra },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, body.error ?? res.statusText)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

async function sha256Base64(blob: Blob) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
  return btoa(String.fromCharCode(...digest))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function withRetries<T>(fn: () => Promise<T>, retries: number, backoffMs: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      // a 4xx will not get better by trying again
      const permanent = err instanceof ApiError && err.status < 500 && err.status !== 403
      if (permanent || attempt >= retries) throw err
      await sleep(Math.min(backoffMs * 2 ** attempt, 10_000))
    }
  }
}

// same file, same key: lets a reload pick the old upload back up
const fingerprint = (f: FileLike) => `upload:${f.name}:${f.size}:${f.lastModified ?? 0}`

async function startOrResume(file: FileLike, o: Required<Pick<UploadOptions, 'api'>> & UploadOptions) {
  const fp = fingerprint(file)
  const saved = o.store?.get(fp)
  if (saved) {
    try {
      const p = await api<{ partBytes: number; partCount: number; parts: { n: number }[] }>(
        o.api,
        `/api/uploads/${saved}/parts`,
        undefined,
        o.headers,
      )
      return { plan: { id: saved, partBytes: p.partBytes, partCount: p.partCount }, have: new Set(p.parts.map((x) => x.n)) }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err // network trouble: keep the saved id
      o.store?.delete(fp) // gone or already finished, start fresh
    }
  }
  const plan = await api<Plan>(o.api, '/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type || 'video/mp4' }),
  }, o.headers)
  o.store?.set(fp, plan.id)
  return { plan, have: new Set<number>() }
}

export async function upload(file: FileLike, opts: UploadOptions) {
  const { concurrency = 4, retries = 4, backoffMs = 500, onProgress, signal } = opts
  const { plan, have } = await startOrResume(file, opts)

  let done = 0
  for (const n of have) done += Math.min(plan.partBytes, file.size - (n - 1) * plan.partBytes)
  onProgress?.(done, file.size)

  const todo: number[] = []
  for (let n = 1; n <= plan.partCount; n++) if (!have.has(n)) todo.push(n)
  const sent = { parts: 0, bytes: 0 }

  async function sendPart(n: number) {
    const body = file.slice((n - 1) * plan.partBytes, n * plan.partBytes)
    const sha256 = await sha256Base64(body)
    await withRetries(
      async () => {
        signal?.throwIfAborted()
        // sign on every attempt, an old url may have expired during a long outage
        const { url, headers } = await api<{ url: string; headers: Record<string, string> }>(
          opts.api,
          `/api/uploads/${plan.id}/parts/${n}/url`,
          { method: 'POST', body: JSON.stringify({ sha256 }) },
          opts.headers,
        )
        const res = await fetch(url, { method: 'PUT', body, headers, signal })
        if (!res.ok) throw new ApiError(res.status, `part ${n}: storage said ${res.status}`)
      },
      retries,
      backoffMs,
    )
    sent.parts++
    sent.bytes += body.size
    done += body.size
    onProgress?.(done, file.size)
  }

  const queue = [...todo]
  const lanes = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) await sendPart(n)
  })
  // let one failed lane stop the others instead of letting them run on
  await Promise.all(lanes.map((lane) => lane.catch((e) => ((queue.length = 0), Promise.reject(e)))))

  await withRetries(() => api(opts.api, `/api/uploads/${plan.id}/complete`, { method: 'POST' }, opts.headers), retries, backoffMs)
  opts.store?.delete(fingerprint(file))
  return { id: plan.id, partsSent: sent.parts, bytesSent: sent.bytes, partsSkipped: have.size }
}
