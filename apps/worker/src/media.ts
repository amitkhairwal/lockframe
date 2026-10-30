// Pure helpers for the transcode pipeline: no I/O, so they are easy to test.

export interface Rung {
  height: number
  video: string // average bitrate target
  max: string
  buf: string
}

// Same codec profile on every rung, so the master playlist can state one CODECS string.
export const LADDER: Rung[] = [
  { height: 1080, video: '5000k', max: '5350k', buf: '7500k' },
  { height: 720, video: '2800k', max: '2996k', buf: '4200k' },
  { height: 480, video: '1400k', max: '1498k', buf: '2100k' },
  { height: 360, video: '800k', max: '856k', buf: '1200k' },
]

export const SEGMENT_SECONDS = 6
export const KEYFRAME_SECONDS = 2 // three keyframes per segment
export const AUDIO_BPS = 128_000
export const CODECS = 'avc1.640029,mp4a.40.2' // High@4.1 plus AAC-LC

export class InvalidMedia extends Error {
  override name = 'InvalidMedia'
}

export interface Source {
  width: number
  height: number
  duration: number
  fps: number
  hasAudio: boolean
  codec: string
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

// Never upscale: rungs above the source height are dropped. A tiny source gets one rung at its own height.
export function pickLadder(sourceHeight: number): Rung[] {
  const rungs = LADDER.filter((r) => r.height <= sourceHeight)
  if (rungs.length) return rungs
  const base = LADDER.at(-1)!
  return [{ ...base, height: Math.max(2, Math.floor(sourceHeight / 2) * 2) }] // round down: never upscale
}

export function rungWidth(source: Pick<Source, 'width' | 'height'>, height: number) {
  return even((source.width * height) / source.height)
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  disposition?: { attached_pic?: number }
}

export function parseProbe(json: unknown, maxDurationSeconds: number): Source {
  const data = json as { streams?: ProbeStream[]; format?: { duration?: string } }
  const streams = data?.streams ?? []
  // cover art in an audio file shows up as a one-frame video stream
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video?.width || !video.height) throw new InvalidMedia('this file has no video stream')

  const duration = Number(data.format?.duration ?? video.duration)
  if (!Number.isFinite(duration) || duration < 0.5) throw new InvalidMedia('the video is too short or has no duration')
  if (duration > maxDurationSeconds) {
    throw new InvalidMedia(`the video is longer than the ${Math.round(maxDurationSeconds / 60)} minute limit`)
  }

  const [n = 0, d = 1] = (video.avg_frame_rate ?? video.r_frame_rate ?? '0/1').split('/').map(Number)
  const fps = d ? n / d : 0
  return {
    width: video.width,
    height: video.height,
    duration,
    fps: fps > 0 && fps < 240 ? fps : 25,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    codec: video.codec_name ?? 'unknown',
  }
}

export function encodeArgs(o: { input: string; outDir: string; rung: Rung; hasAudio: boolean; threads: number }) {
  const { input, outDir, rung, hasAudio, threads } = o
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-i', input,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []),
    '-vf', `scale=-2:${rung.height},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1',
    '-b:v', rung.video, '-maxrate', rung.max, '-bufsize', rung.buf,
    // fixed keyframe times and no scene-cut keyframes: every rung cuts at the same instants
    '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`,
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_BPS / 1000}k`, '-ar', '48000', '-ac', '2'] : []),
    ...(threads > 0 ? ['-threads', String(threads)] : []),
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${outDir}/seg_%05d.ts`, `${outDir}/index.m3u8`,
  ]
}

export function probeArgs(input: string) {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input]
}

// ffmpeg -progress prints key=value lines; out_time_us is the encoded position in microseconds
export function parseProgress(line: string, durationSeconds: number): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim())
  if (!m || durationSeconds <= 0) return null
  return Math.min(99, Math.floor((Number(m[1]) / 1e6 / durationSeconds) * 100))
}

export interface RenditionInfo {
  height: number
  width: number
  bandwidth: number
}

export function masterPlaylist(renditions: RenditionInfo[], hasAudio = true) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS']
  for (const r of [...renditions].sort((a, b) => b.height - a.height)) {
    const codecs = hasAudio ? CODECS : CODECS.split(',')[0]
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height},CODECS="${codecs}"`, `${r.height}/index.m3u8`)
  }
  return lines.join('\n') + '\n'
}

// peak rate we promised the encoder, plus audio: what a player should assume
export const peakBandwidth = (rung: Rung, hasAudio: boolean) =>
  parseInt(rung.max, 10) * 1000 + (hasAudio ? AUDIO_BPS : 0)
