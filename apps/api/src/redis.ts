import type { ConnectionOptions } from 'bullmq'

// BullMQ takes connection options, not a url
export function connectionOptions(url: string): ConnectionOptions {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
  }
}

// one channel carries every video state change from the workers to the API
export const VIDEO_CHANNEL = 'sv:video'

export interface VideoEvent {
  id: string
  owner: string
  status: 'uploaded' | 'processing' | 'ready' | 'failed'
  progress: number
  failure?: string
  retryable?: boolean
}
