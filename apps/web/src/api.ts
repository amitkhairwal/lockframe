export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function call<T>(path: string, method = 'GET', json?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: json === undefined ? undefined : { 'content-type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, body.error ?? res.statusText)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export interface User {
  id: string
  email: string
}

export interface VideoRow {
  id: string
  title: string
  status: string
  size: number
  createdAt: string
  progress: number
  failure?: string
  retryable?: boolean
  heights?: number[]
  role: 'owner' | 'viewer'
  viewers?: string[]
  duration?: number
  position?: number // where this person stopped, seconds
  completed?: boolean
}

// what the server pushes while a video moves through the pipeline
export interface VideoEvent {
  id: string
  status: string
  progress: number
  failure?: string
  retryable?: boolean
}

export interface Playback {
  token: string
  expiresIn: number
  lease: string
  master: string
  viewer: string
  resume: number
}

export interface Understanding {
  status: 'pending' | 'running' | 'done' | 'failed' | 'off'
  error?: string
  chapters: { start: number; title: string }[]
  hasCaptions: boolean
}
export interface Hit {
  videoId: string
  start: number
  at: string
  snippet: string
}
export interface Answer {
  found: boolean
  answer: string
  citations: Hit[]
}

export interface Flag {
  id: string
  video: string
  title?: string
  viewer: string
  rule: string
  text: string
  count: number
  windowMinutes: number
  lastAt: string
  summary?: string
}
export interface Overview {
  starts: number
  watchers: number
  completed: number
  recent: { position: number; completed: boolean; lastSeen: string; starts: number; you: boolean }[]
}
