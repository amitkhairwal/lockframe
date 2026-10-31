import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'

const MiB = 1024 * 1024

const num = (name: string, fallback: number) => {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
  return n
}

const nonNegative = (name: string, fallback: number) => {
  const n = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be zero or more`)
  return n
}

const s3Endpoint = process.env.S3_ENDPOINT
const production = process.env.NODE_ENV === 'production'

let cachedSecret: string | undefined

function sessionSecret() {
  const secret = process.env.JWT_SECRET
  if (secret && secret.length >= 32) return secret
  if (production) throw new Error('JWT_SECRET must be set to at least 32 characters in production')
  return randomBytes(32).toString('hex') // dev only: sessions end when the process restarts
}

export const config = {
  port: num('PORT', 3000),
  // read lazily so the worker, which never signs sessions, can run without JWT_SECRET
  get sessionSecret() {
    return (cachedSecret ??= sessionSecret())
  },
  sessionDays: num('SESSION_DAYS', 7),
  secureCookies: production,
  // number of proxy hops in front of us; 0 means never trust X-Forwarded-For
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lockframe',
  s3: {
    endpoint: s3Endpoint,
    // the address a browser can reach; differs from endpoint inside docker
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? s3Endpoint,
    region: process.env.S3_REGION ?? 'auto',
    bucket: process.env.S3_BUCKET ?? 'lockframe',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
  },
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queuePrefix: process.env.QUEUE_PREFIX ?? 'sv',
  media: {
    ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
    threads: nonNegative('FFMPEG_THREADS', 0), // 0 lets ffmpeg decide
    tmpDir: process.env.TMP_DIR ?? tmpdir(),
    maxDurationSeconds: num('MAX_DURATION_SECONDS', 7200),
    maxHeight: num('MAX_HEIGHT', 1080), // tallest rung; lower it on a small host to save memory and time
  },
  worker: {
    encodeConcurrency: num('ENCODE_CONCURRENCY', 1),
    lockMs: num('WORKER_LOCK_MS', 30_000), // a killed worker's job is taken over after about this long
    attempts: num('JOB_ATTEMPTS', 3),
    backoffMs: num('JOB_BACKOFF_MS', 5_000),
  },
  hls: {
    // written in front of /api/keys/... in the playlists at encode time; empty means same origin as the playlist
    keyUrlBase: (process.env.KEY_URL_BASE ?? '').replace(/\/$/, ''),
    // where players fetch playlists and segments: a bucket or CDN in production, our own /media route in dev
    mediaBase: process.env.HLS_BASE_URL ?? '/media',
    segmentsPerKey: num('KEY_ROTATE_SEGMENTS', 5),
  },
  playback: {
    tokenSeconds: num('PLAYBACK_TOKEN_SECONDS', 120),
    leaseSeconds: num('LEASE_SECONDS', 90), // how long a device keeps the one playback slot without a heartbeat
  },
  ai: {
    key: process.env.GROQ_API_KEY ?? '',
    baseUrl: (process.env.AI_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    sttModel: process.env.STT_MODEL ?? 'whisper-large-v3-turbo',
    llmModel: process.env.LLM_MODEL ?? 'openai/gpt-oss-120b',
    pieceSeconds: num('AUDIO_PIECE_SECONDS', 600), // each piece must stay under the provider's upload limit
    overlapSeconds: num('AUDIO_OVERLAP_SECONDS', 6),
    attempts: num('AI_JOB_ATTEMPTS', 5),
    backoffMs: num('AI_JOB_BACKOFF_MS', 15_000), // 429s from a free tier clear in about a minute
    asksPerMinute: num('ASKS_PER_MIN', 6),
  },
  // thresholds for the playback flags; a rule fires when its count is reached inside its window
  flags: {
    deviceDenials: num('FLAG_DEVICE_DENIALS', 3), // refused second-device attempts
    deviceWindowMin: 10,
    replayStarts: num('FLAG_REPLAY_STARTS', 6), // fresh playback starts of the same video
    replayWindowMin: 60,
    aheadSeconds: num('FLAG_AHEAD_SECONDS', 120), // a key this far past the playhead is odd: players buffer about 30 s
    aheadCount: num('FLAG_AHEAD_COUNT', 3),
    aheadWindowMin: 10,
    burstKeys: num('FLAG_BURST_KEYS', 12), // key requests inside burstSeconds
    burstSeconds: 60,
    summaryCooldownMin: 10,
  },
  keysPerMinute: num('KEYS_PER_MIN', 600), // per address, on the key route
  eventDays: num('EVENT_DAYS', 30),
  // built player (npm run build); the API serves it when the folder exists, so one deployment is one link
  webDir: process.env.WEB_DIR ?? 'apps/web/dist',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
  partBytes: num('PART_BYTES', 8 * MiB),
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 10 * 1024 * MiB),
  staleUploadHours: num('STALE_UPLOAD_HOURS', 24),
}
