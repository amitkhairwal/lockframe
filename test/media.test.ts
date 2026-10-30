import { describe, expect, it } from 'vitest'
import {
  InvalidMedia,
  LADDER,
  encodeArgs,
  masterPlaylist,
  parseProbe,
  parseProgress,
  peakBandwidth,
  pickLadder,
  rungWidth,
} from '../apps/worker/src/media.js'

describe('pickLadder', () => {
  it('keeps every rung at or below the source height', () => {
    expect(pickLadder(1080).map((r) => r.height)).toEqual([1080, 720, 480, 360])
    expect(pickLadder(1200).map((r) => r.height)).toEqual([1080, 720, 480, 360])
    expect(pickLadder(720).map((r) => r.height)).toEqual([720, 480, 360])
    expect(pickLadder(480).map((r) => r.height)).toEqual([480, 360])
    expect(pickLadder(360).map((r) => r.height)).toEqual([360])
  })

  it('never upscales and is never empty', () => {
    for (const h of [2160, 1080, 719, 361, 360, 359, 240, 144, 2, 1]) {
      const rungs = pickLadder(h)
      expect(rungs.length).toBeGreaterThan(0)
      if (h >= 360) expect(Math.max(...rungs.map((r) => r.height))).toBeLessThanOrEqual(h)
    }
  })

  it('gives a tiny source one rung at its own even height', () => {
    expect(pickLadder(240).map((r) => r.height)).toEqual([240])
    expect(pickLadder(241).map((r) => r.height)).toEqual([240])
  })

  it('has strictly falling bitrates down the ladder', () => {
    const rates = LADDER.map((r) => parseInt(r.video, 10))
    expect([...rates].sort((a, b) => b - a)).toEqual(rates)
  })
})

describe('rungWidth', () => {
  it('keeps the aspect ratio and stays even', () => {
    expect(rungWidth({ width: 1920, height: 1080 }, 720)).toBe(1280)
    expect(rungWidth({ width: 1280, height: 720 }, 360)).toBe(640)
    expect(rungWidth({ width: 1000, height: 563 }, 360) % 2).toBe(0)
  })
})

describe('parseProbe', () => {
  const ok = {
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    format: { duration: '125.5' },
  }

  it('reads a normal video', () => {
    const s = parseProbe(ok, 3600)
    expect(s).toMatchObject({ width: 1920, height: 1080, duration: 125.5, hasAudio: true, codec: 'h264' })
    expect(s.fps).toBeCloseTo(29.97, 2)
  })

  it('works without audio', () => {
    expect(parseProbe({ ...ok, streams: [ok.streams[0]] }, 3600).hasAudio).toBe(false)
  })

  it('refuses audio only, cover art only, empty and garbage input', () => {
    const audio = { streams: [{ codec_type: 'audio' }], format: { duration: '60' } }
    const art = { streams: [{ codec_type: 'video', width: 500, height: 500, disposition: { attached_pic: 1 } }], format: { duration: '60' } }
    for (const bad of [audio, art, {}, null, 'text']) expect(() => parseProbe(bad, 3600)).toThrow(InvalidMedia)
  })

  it('refuses a zero, tiny or too long duration', () => {
    const v = [ok.streams[0]]
    expect(() => parseProbe({ streams: v, format: {} }, 3600)).toThrow(/duration/)
    expect(() => parseProbe({ streams: v, format: { duration: '0.1' } }, 3600)).toThrow(/short/)
    expect(() => parseProbe({ streams: v, format: { duration: '7300' } }, 7200)).toThrow(/limit/)
  })

  it('falls back to 25 fps for a nonsense frame rate', () => {
    expect(parseProbe({ streams: [{ codec_type: 'video', width: 10, height: 10, avg_frame_rate: '0/0' }], format: { duration: '5' } }, 60).fps).toBe(25)
  })
})

describe('encodeArgs', () => {
  const args = encodeArgs({ input: 'in.mp4', outDir: '/t/720', rung: LADDER[1]!, hasAudio: true, threads: 2 })
  const after = (flag: string) => args[args.indexOf(flag) + 1]

  it('uses fixed keyframe times and no scene cuts so rungs align', () => {
    expect(after('-sc_threshold')).toBe('0')
    expect(after('-force_key_frames')).toBe('expr:gte(t,n_forced*2)')
    expect(after('-hls_time')).toBe('6')
  })

  it('scales to the rung height with an even width', () => {
    expect(after('-vf')).toBe('scale=-2:720,format=yuv420p')
  })

  it('maps audio only when the source has it', () => {
    expect(args).toContain('0:a:0')
    const mute = encodeArgs({ input: 'in.mp4', outDir: '/t', rung: LADDER[3]!, hasAudio: false, threads: 0 })
    expect(mute).not.toContain('0:a:0')
    expect(mute).not.toContain('-c:a')
    expect(mute).not.toContain('-threads')
  })

  it('never goes through a shell, so a hostile url stays one argument', () => {
    const evil = encodeArgs({ input: 'http://x/a.mp4?$(rm -rf ~)&b=1', outDir: '/t', rung: LADDER[0]!, hasAudio: true, threads: 1 })
    expect(evil[evil.indexOf('-i') + 1]).toBe('http://x/a.mp4?$(rm -rf ~)&b=1')
  })
})

describe('parseProgress', () => {
  it('turns out_time into a percentage and caps at 99', () => {
    expect(parseProgress('out_time_us=30000000', 60)).toBe(50)
    expect(parseProgress('out_time_ms=61000000', 60)).toBe(99)
  })
  it('ignores other lines', () => {
    expect(parseProgress('frame=100', 60)).toBeNull()
    expect(parseProgress('out_time_us=N/A', 60)).toBeNull()
    expect(parseProgress('out_time_us=5', 0)).toBeNull()
  })
})

describe('masterPlaylist', () => {
  it('lists the highest rung first with resolution, bandwidth and codecs', () => {
    const text = masterPlaylist([
      { height: 360, width: 640, bandwidth: 984000 },
      { height: 720, width: 1280, bandwidth: peakBandwidth(LADDER[1]!, true) },
    ])
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('#EXTM3U')
    expect(text.indexOf('720/index.m3u8')).toBeLessThan(text.indexOf('360/index.m3u8'))
    expect(text).toContain('RESOLUTION=1280x720')
    expect(text).toContain('BANDWIDTH=3124000')
    expect(text).toContain('CODECS="avc1.640029,mp4a.40.2"')
  })

  it('leaves the audio codec out for a silent video', () => {
    expect(masterPlaylist([{ height: 360, width: 640, bandwidth: 1 }], false)).toContain('CODECS="avc1.640029"')
  })
})
