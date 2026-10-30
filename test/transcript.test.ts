import { describe, expect, it } from 'vitest'
import { audioPieces, chunkSegments, cleanChapters, finishChapters, mergePieces, mmss, parseJson, toVtt, type Segment } from '../apps/api/src/transcript.js'

const seg = (start: number, end: number, text: string): Segment => ({ start, end, text })
// one sentence every 5 s, "s0", "s1" ...
const speech = (n: number, step = 5) => Array.from({ length: n }, (_, i) => seg(i * step, i * step + step - 0.5, `Sentence ${i}.`))

describe('mergePieces', () => {
  it('keeps every sentence exactly once across overlapping pieces', () => {
    const all = speech(40) // 200 s of speech
    // pieces of 100 s with 10 s overlap: offsets 0 and 90, times are relative to the piece
    const pieceOf = (offset: number, length: number, overlap: number) => ({
      offset,
      overlap,
      segments: all.filter((s) => s.end > offset && s.start < offset + length).map((s) => seg(s.start - offset, s.end - offset, s.text)),
    })
    const merged = mergePieces([pieceOf(0, 100, 0), pieceOf(90, 110, 10)])
    expect(merged.map((s) => s.text)).toEqual(all.map((s) => s.text))
    expect(merged.map((s) => s.start)).toEqual(all.map((s) => s.start))
  })

  it('adds the piece offset to timestamps, sorts, and drops empty text', () => {
    const out = mergePieces([{ offset: 0, overlap: 0, segments: [seg(10, 12, 'b'), seg(1, 2, 'a'), seg(3, 4, '  ')] }])
    expect(out.map((s) => s.text)).toEqual(['a', 'b'])
  })

  it('handles a single piece and no pieces', () => {
    expect(mergePieces([])).toEqual([])
    expect(mergePieces([{ offset: 0, overlap: 0, segments: speech(3) }])).toHaveLength(3)
  })
})

describe('chunkSegments', () => {
  it('cuts 30 to 60 s chunks between segments, in order, losing no text', () => {
    const s = speech(100) // 500 s
    const chunks = chunkSegments(s)
    for (const c of chunks.slice(0, -1)) {
      expect(c.end - c.start).toBeGreaterThanOrEqual(25) // min 30 minus the last short segment
      expect(c.end - c.start).toBeLessThanOrEqual(60)
    }
    expect(chunks.map((c) => c.i)).toEqual(chunks.map((_, i) => i))
    expect(chunks.flatMap((c) => c.text.split(' Sentence ').length)).not.toHaveLength(0)
    expect(chunks.map((c) => c.text).join(' ')).toBe(s.map((x) => x.text).join(' '))
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end)
  })

  it('never splits inside one long segment, and attaches a tiny tail to the previous chunk', () => {
    expect(chunkSegments([seg(0, 90, 'one very long sentence')])).toHaveLength(1)
    const s = [...speech(8), seg(40, 42, 'bye.')] // 40 s then a 2 s tail
    const chunks = chunkSegments(s)
    expect(chunks.at(-1)!.text).toContain('bye.')
    expect(chunks.at(-1)!.end).toBe(42)
  })

  it('returns nothing for no speech', () => {
    expect(chunkSegments([])).toEqual([])
  })
})

describe('toVtt', () => {
  it('writes a valid file with escaped text and no zero length cues', () => {
    const vtt = toVtt([seg(0, 2.5, 'Hello <b> & --> bye'), seg(3661.2, 3661.2, 'late')])
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500')
    expect(vtt).toContain('01:01:01.200 --> 01:01:01.400')
    expect(vtt).toContain('Hello &lt;b> &amp; -> bye')
    expect(vtt.match(/-->/g)).toHaveLength(2)
  })
})

describe('chapters', () => {
  it('keeps sound entries only', () => {
    const raw = [
      { start: 0, title: 'Intro' },
      { start: 'x', title: 'bad start' },
      { start: 100, title: 12 },
      { start: 5000, title: 'past the end' },
      { start: 600, title: '  Closures   <script>in JS ' },
      null,
      { start: 605, title: 'too close to the last one' },
      { start: 1200, title: 'x'.repeat(200) },
    ]
    const out = cleanChapters(raw, 3600)
    expect(out.map((c) => c.start)).toEqual([0, 600, 1200])
    expect(out[1]!.title).toBe('Closures in JS')
    expect(out[2]!.title).toHaveLength(70)
  })

  it('drops everything that is not a list, and entries before the window', () => {
    expect(cleanChapters({ start: 0, title: 'x' }, 100)).toEqual([])
    expect(cleanChapters('nope', 100)).toEqual([])
    expect(cleanChapters([{ start: 10, title: 'early' }], 100, 50)).toEqual([])
  })

  it('starts the list at zero', () => {
    expect(finishChapters([{ start: 30, title: 'A' }])[0]).toEqual({ start: 0, title: 'Introduction' })
    expect(finishChapters([{ start: 0, title: 'A' }])).toHaveLength(1)
    expect(finishChapters([])).toEqual([])
  })
})

describe('small helpers', () => {
  it('formats time', () => {
    expect(mmss(0)).toBe('0:00')
    expect(mmss(75.9)).toBe('1:15')
    expect(mmss(3725)).toBe('1:02:05')
  })
  it('reads json that comes in a code fence or bare, and gives undefined otherwise', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJson('{"a":2}')).toEqual({ a: 2 })
    expect(parseJson('sure! here you go')).toBeUndefined()
  })
})

describe('audioPieces', () => {
  it('is one piece for a short video', () => {
    expect(audioPieces(90, 600, 6)).toEqual([{ offset: 0, length: 90, overlap: 0 }])
    expect(audioPieces(600, 600, 6)).toEqual([{ offset: 0, length: 600, overlap: 0 }])
  })
  it('overlaps pieces and covers the whole duration with no gap', () => {
    const p = audioPieces(1500, 600, 6)
    expect(p).toEqual([
      { offset: 0, length: 600, overlap: 0 },
      { offset: 594, length: 600, overlap: 6 },
      { offset: 1188, length: 312, overlap: 6 },
    ])
    for (let i = 1; i < p.length; i++) expect(p[i]!.offset).toBeLessThan(p[i - 1]!.offset + p[i - 1]!.length) // they overlap
    expect(p.at(-1)!.offset + p.at(-1)!.length).toBe(1500)
  })
  it('the overlap belongs to the last piece when a video is one overlap longer than a piece', () => {
    const p = audioPieces(605, 600, 6)
    expect(p).toHaveLength(2)
    expect(p[1]!.offset + p[1]!.length).toBe(605)
  })
})
