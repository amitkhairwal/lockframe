import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptSegment, encryptPlaylist, encryptSegment, segmentIv } from '../apps/worker/src/crypto.js'

const playlist = (n: number, extra = '') =>
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', extra, '#EXT-X-PLAYLIST-TYPE:VOD']
    .filter(Boolean)
    .concat(Array.from({ length: n }, (_, i) => `#EXTINF:6.000000,\nseg_${String(i).padStart(5, '0')}.ts`))
    .concat('#EXT-X-ENDLIST', '')
    .join('\n')

describe('segment encryption', () => {
  const key = randomBytes(16)
  const data = randomBytes(188 * 100)

  it('round trips', () => {
    expect(decryptSegment(encryptSegment(data, key, 3), key, 3).equals(data)).toBe(true)
  })

  it('does not leak the plaintext and pads to a block', () => {
    const enc = encryptSegment(data, key, 0)
    expect(enc.length % 16).toBe(0)
    expect(enc.length).toBeGreaterThan(data.length)
    expect(enc.subarray(0, 64).equals(data.subarray(0, 64))).toBe(false)
  })

  it('is useless with the wrong key or the wrong sequence number', () => {
    const enc = encryptSegment(data, key, 4)
    expect(() => decryptSegment(enc, randomBytes(16), 4)).toThrow() // bad padding almost always
    const other = decryptSegment(enc, key, 5) // right key, wrong IV: only the first block is damaged
    expect(other.subarray(0, 16).equals(data.subarray(0, 16))).toBe(false)
  })

  it('uses the sequence number as a big-endian IV', () => {
    expect(segmentIv(0).equals(Buffer.alloc(16))).toBe(true)
    expect(segmentIv(258).toString('hex')).toBe('00000000000000000000000000000102')
  })
})

describe('encryptPlaylist', () => {
  const keyUri = (g: number) => `https://api.example/keys/${g}`

  it('puts a new key before every fifth segment', () => {
    const r = encryptPlaylist(playlist(12), { keyUri, perKey: 5 })
    expect(r.groups).toBe(3)
    expect(r.segments).toHaveLength(12)
    const lines = r.text.split('\n')
    const keyAt = lines.flatMap((l, i) => (l.startsWith('#EXT-X-KEY') ? [i] : []))
    expect(keyAt).toHaveLength(3)
    // each key tag sits directly before the EXTINF of segment 0, 5 and 10
    for (const [n, at] of keyAt.entries()) {
      expect(lines[at]).toContain(`/keys/${n}"`)
      expect(lines[at + 1]).toMatch(/^#EXTINF/)
      expect(lines[at + 2]).toBe(`seg_${String(n * 5).padStart(5, '0')}.ts`)
    }
    expect(r.text).toContain('METHOD=AES-128')
    expect(r.text).not.toMatch(/IV=/)
  })

  it('handles one segment, an exact multiple, and a long video', () => {
    expect(encryptPlaylist(playlist(1), { keyUri, perKey: 5 }).groups).toBe(1)
    expect(encryptPlaylist(playlist(10), { keyUri, perKey: 5 }).groups).toBe(2)
    expect(encryptPlaylist(playlist(601), { keyUri, perKey: 5 }).groups).toBe(121)
  })

  it('keeps every other line as it was', () => {
    const src = playlist(7)
    const out = encryptPlaylist(src, { keyUri, perKey: 3 }).text.split('\n').filter((l) => !l.startsWith('#EXT-X-KEY'))
    expect(out.join('\n')).toBe(src)
  })

  it('refuses a playlist it cannot encrypt safely', () => {
    expect(() => encryptPlaylist(playlist(3).replace('SEQUENCE:0', 'SEQUENCE:7'), { keyUri, perKey: 5 })).toThrow(/sequence 0/)
    expect(() => encryptPlaylist(playlist(3, '#EXT-X-KEY:METHOD=AES-128,URI="x"'), { keyUri, perKey: 5 })).toThrow(/already encrypted/)
  })
})
