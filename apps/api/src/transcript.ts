// Pure helpers for transcripts. No I/O, so they are cheap to test.

export interface Segment {
  start: number
  end: number
  text: string
}

export interface Chunk extends Segment {
  i: number
  segments: Segment[] // kept so a hit can point at the sentence, not just the minute
}

export interface Chapter {
  start: number
  title: string
}

export const mmss = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

// Audio is cut into pieces that overlap, so a sentence on a cut is heard whole by one of them.
// Each piece owns the span from its own start (or the middle of the overlap) to the middle of the next overlap.
// A segment belongs to the piece that owns its midpoint, so it is kept exactly once.
export function mergePieces(pieces: { offset: number; overlap: number; segments: Segment[] }[]): Segment[] {
  const out: Segment[] = []
  for (const [i, p] of pieces.entries()) {
    const from = i === 0 ? 0 : p.offset + p.overlap / 2
    const next = pieces[i + 1]
    const to = next ? next.offset + next.overlap / 2 : Infinity
    for (const s of p.segments) {
      const start = s.start + p.offset
      const end = s.end + p.offset
      const mid = (start + end) / 2
      const text = s.text.trim()
      if (text && mid >= from && mid < to) out.push({ start, end: Math.max(end, start), text })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// 30 to 60 s of speech per chunk, always cut between segments. A single long segment stays whole.
export function chunkSegments(segments: Segment[], min = 30, max = 60): Chunk[] {
  const chunks: Chunk[] = []
  let cur: Segment[] = []
  const flush = () => {
    if (!cur.length) return
    chunks.push({ i: chunks.length, start: cur[0]!.start, end: cur.at(-1)!.end, text: cur.map((s) => s.text).join(' '), segments: cur })
    cur = []
  }
  for (const s of segments) {
    if (cur.length && s.end - cur[0]!.start > max) flush()
    cur.push(s)
    if (s.end - cur[0]!.start >= min && /[.!?]["')\]]?$/.test(s.text)) flush() // prefer to stop at a sentence end
  }
  flush()
  // a tiny tail reads better attached to the chunk before it
  const last = chunks.at(-1)
  const prev = chunks.at(-2)
  if (last && prev && last.end - last.start < min / 2 && last.end - prev.start <= max * 1.25) {
    prev.end = last.end
    prev.text += ' ' + last.text
    prev.segments.push(...last.segments)
    chunks.pop()
  }
  return chunks
}

const vttTime = (s: number) => {
  const ms = Math.round(s * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))}.${p(ms % 1000, 3)}`
}

export function toVtt(segments: Segment[]) {
  const cues = segments.map((s, i) => {
    const end = Math.max(s.end, s.start + 0.2) // a zero length cue is dropped by players
    const text = s.text.replace(/-->/g, '->').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    return `${i + 1}\n${vttTime(s.start)} --> ${vttTime(end)}\n${text}\n`
  })
  return `WEBVTT\n\n${cues.join('\n')}`
}

// What the model returns is untrusted. Keep what is sound, drop the rest.
export function cleanChapters(raw: unknown, duration: number, windowStart = 0): Chapter[] {
  if (!Array.isArray(raw)) return []
  const out: Chapter[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const { start, title } = r as { start?: unknown; title?: unknown }
    if (typeof start !== 'number' || !Number.isFinite(start) || typeof title !== 'string') continue
    const t = title.replace(/<[^>]*>|[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)
    if (!t || start < windowStart || start >= duration) continue
    out.push({ start: Math.round(start), title: t })
  }
  out.sort((a, b) => a.start - b.start)
  return out.filter((c, i) => i === 0 || c.start - out[i - 1]!.start >= 20) // chapters closer than 20 s are noise
}

// first chapter at 0 so the list covers the whole video
export function finishChapters(chapters: Chapter[]): Chapter[] {
  if (!chapters.length) return []
  return chapters[0]!.start === 0 ? chapters : [{ start: 0, title: 'Introduction' }, ...chapters]
}

export function parseJson(text: string): unknown {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text
  try {
    return JSON.parse(body.trim())
  } catch {
    return undefined
  }
}

// Where to cut the audio. Pieces overlap by `overlap` seconds, the last one is as long as what is left.
export function audioPieces(duration: number, piece: number, overlap: number) {
  const step = piece - overlap
  const out: { offset: number; length: number; overlap: number }[] = []
  for (let offset = 0; ; offset += step) {
    const length = Math.min(piece, duration - offset)
    out.push({ offset, length, overlap: out.length ? overlap : 0 })
    if (offset + piece >= duration) return out
  }
}

// Words worth looking for: 3+ letters, plural and -ing/-ed endings trimmed so "closures" finds "closure".
export function terms(text: string) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  return [...new Set(words.map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w)))]
}

// The sentence inside a chunk that best matches (most terms), or the chunk's first one.
export function bestSegment(chunk: Pick<Chunk, 'segments'>, wanted: string[]): Segment {
  let best = chunk.segments[0]!
  let top = 0
  for (const s of chunk.segments) {
    const low = s.text.toLowerCase()
    const n = wanted.filter((t) => low.includes(t)).length
    if (n > top) {
      top = n
      best = s
    }
  }
  return best
}
