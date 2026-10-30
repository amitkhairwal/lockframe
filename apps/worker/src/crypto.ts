import { createCipheriv, createDecipheriv } from 'node:crypto'

// HLS AES-128: whole segment, CBC, PKCS7 padding. With no IV in the playlist the
// IV is the media sequence number as 16 big-endian bytes.
export function segmentIv(sequence: number) {
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(sequence >>> 0, 12)
  return iv
}

export function encryptSegment(data: Buffer, key: Buffer, sequence: number) {
  const c = createCipheriv('aes-128-cbc', key, segmentIv(sequence))
  return Buffer.concat([c.update(data), c.final()])
}

export function decryptSegment(data: Buffer, key: Buffer, sequence: number) {
  const d = createDecipheriv('aes-128-cbc', key, segmentIv(sequence))
  return Buffer.concat([d.update(data), d.final()])
}

// Adds an EXT-X-KEY tag before every perKey-th segment. Segment i is encrypted with key
// group floor(i / perKey), so the player has to come back for a new key every perKey segments.
export function encryptPlaylist(playlist: string, o: { keyUri: (group: number) => string; perKey: number }) {
  const sequence = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(playlist)
  if (sequence && Number(sequence[1]) !== 0) throw new Error('playlist does not start at sequence 0, the IV rule would break')
  if (/#EXT-X-KEY/.test(playlist)) throw new Error('playlist is already encrypted')

  const out: string[] = []
  const segments: string[] = []
  for (const line of playlist.split('\n')) {
    if (line.startsWith('#EXTINF') && segments.length % o.perKey === 0) {
      out.push(`#EXT-X-KEY:METHOD=AES-128,URI="${o.keyUri(segments.length / o.perKey)}"`)
    }
    if (line && !line.startsWith('#')) segments.push(line)
    out.push(line)
  }
  return { text: out.join('\n'), segments, groups: Math.ceil(segments.length / o.perKey) }
}
