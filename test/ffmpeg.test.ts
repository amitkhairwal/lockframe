import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvalidMedia, pickLadder } from '../apps/worker/src/media.js'
import { Aborted, encodeRung, probe } from '../apps/worker/src/ffmpeg.js'

const sh = promisify(execFile)
let dir: string
let src: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-test-'))
  src = join(dir, 'src.mp4')
  // 14 s of 720p video with a tone: segments of 6 s, 6 s and 2 s
  await sh('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=14',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
    '-c:a', 'aac', '-shortest', src,
  ])
}, 60_000)
afterAll(() => rm(dir, { recursive: true, force: true }))

async function segments(outDir: string) {
  const text = await readFile(join(outDir, 'index.m3u8'), 'utf8')
  const lines = text.split('\n')
  const out: { file: string; seconds: number }[] = []
  lines.forEach((l, i) => {
    const m = /^#EXTINF:([\d.]+)/.exec(l)
    if (m) out.push({ file: lines[i + 1]!, seconds: Number(m[1]) })
  })
  return out
}

// this ffprobe pads its csv with blank lines
const lines = (out: string) => out.split('\n').filter((l) => l.trim())

// presentation times of video packets flagged as keyframes
async function keyTimes(file: string) {
  const { stdout } = await sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file])
  return lines(stdout).map((l) => l.split(',')).filter(([, f]) => f?.includes('K')).map(([t]) => Number(t))
}

describe('probe', () => {
  it('reads the real source', async () => {
    const s = await probe(src)
    expect(s).toMatchObject({ width: 1280, height: 720, hasAudio: true, codec: 'h264' })
    expect(s.duration).toBeCloseTo(14, 0)
    expect(pickLadder(s.height).map((r) => r.height)).toEqual([720, 480, 360])
  })

  it('calls a text file not a video, and a missing file an ordinary error', async () => {
    const txt = join(dir, 'fake.mp4')
    await sh('sh', ['-c', `echo "this is not a video" > ${txt}`])
    await expect(probe(txt)).rejects.toBeInstanceOf(InvalidMedia)
    await expect(probe(join(dir, 'missing.mp4'))).rejects.not.toBeInstanceOf(InvalidMedia)
  })
})

describe('real ladder output', () => {
  const rungs = pickLadder(720)
  const outs = new Map<number, string>()
  const seen: number[] = []

  beforeAll(async () => {
    const source = await probe(src)
    await Promise.all(
      rungs.map(async (rung) => {
        const out = join(dir, String(rung.height))
        await mkdir(out)
        outs.set(rung.height, out)
        await encodeRung({ input: src, outDir: out, rung, source, onProgress: (p) => rung.height === 720 && seen.push(p) })
      }),
    )
  }, 120_000)

  it('writes playlists and segments for every rung', async () => {
    for (const out of outs.values()) {
      const segs = await segments(out)
      expect(segs.map((s) => Math.round(s.seconds))).toEqual([6, 6, 2])
      const files = await readdir(out)
      for (const s of segs) expect(files).toContain(s.file)
    }
  })

  it('starts every segment of every rung on a keyframe', async () => {
    for (const out of outs.values()) {
      for (const s of await segments(out)) {
        const { stdout } = await sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-of', 'csv=p=0', join(out, s.file)])
        expect(lines(stdout)[0], `${out}/${s.file}`).toContain('K')
      }
    }
  })

  it('cuts at the same instants on every rung', async () => {
    const lists = await Promise.all([...outs.values()].map(segments))
    for (const l of lists) {
      expect(l.map((s) => s.seconds.toFixed(2))).toEqual(lists[0]!.map((s) => s.seconds.toFixed(2)))
    }
  })

  it('places keyframes every 2 seconds', async () => {
    const keys = await keyTimes(join(outs.get(720)!, 'seg_00000.ts'))
    expect(keys.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < keys.length; i++) expect(keys[i]! - keys[i - 1]!).toBeCloseTo(2, 1)
  })

  it('shrinks the frame to each rung height', async () => {
    for (const [h, out] of outs) {
      const { stdout } = await sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', join(out, 'seg_00000.ts')])
      expect(Number(lines(stdout)[0])).toBe(h)
    }
  })

  it('reports progress that never goes backwards', () => {
    expect(seen.length).toBeGreaterThan(0)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
  })
})

describe('abort', () => {
  it('stops ffmpeg when asked and leaves no process behind', async () => {
    const source = await probe(src)
    const out = join(dir, 'abort')
    await mkdir(out)
    const ctl = new AbortController()
    const run = encodeRung({ input: src, outDir: out, rung: pickLadder(720)[0]!, source, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 100)
    await expect(run).rejects.toBeInstanceOf(Aborted)
  })
})
