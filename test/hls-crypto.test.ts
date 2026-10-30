import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeRung, probe } from '../apps/worker/src/ffmpeg.js'
import { encryptPlaylist, encryptSegment } from '../apps/worker/src/crypto.js'
import { pickLadder } from '../apps/worker/src/media.js'

const sh = promisify(execFile)
let dir: string
let server: Server
let base: string
const keys = [randomBytes(16), randomBytes(16), randomBytes(16)] // 14 s is 3 segments, one key each
const hits: string[] = []
const mode = { keys: 'ok' as 'ok' | 'refuse' | 'wrong' }

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sv-test-'))
  const src = join(dir, 'src.mp4')
  await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=14', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-shortest', src])

  const out = join(dir, 'hls')
  await mkdir(out)
  const source = await probe(src)
  await encodeRung({ input: src, outDir: out, rung: pickLadder(360)[0]!, source })

  server = createServer(async (req, res) => {
    const url = req.url!
    const m = /^\/key\/(\d+)$/.exec(url)
    if (m) {
      hits.push(url)
      if (mode.keys === 'refuse' || req.headers.authorization !== 'Bearer good-token') return void res.writeHead(403).end()
      return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(mode.keys === 'wrong' ? randomBytes(16) : keys[Number(m[1])])
    }
    try {
      res.writeHead(200).end(await readFile(join(dir, 'served', url)))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // what the worker does: encrypt segments, rewrite the playlist
  await mkdir(join(dir, 'served'))
  const playlist = await readFile(join(out, 'index.m3u8'), 'utf8')
  const enc = encryptPlaylist(playlist, { keyUri: (g) => `${base}/key/${g}`, perKey: 1 })
  expect(enc.groups).toBe(3)
  for (const [i, name] of enc.segments.entries()) {
    await writeFile(join(dir, 'served', name), encryptSegment(await readFile(join(out, name)), keys[i]!, i))
  }
  await writeFile(join(dir, 'served', 'index.m3u8'), enc.text)
  await writeFile(join(dir, 'plain.m3u8'), playlist)
}, 90_000)

afterAll(async () => {
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

const args = (input: string, token = 'good-token') => ['-v', 'error', '-headers', `Authorization: Bearer ${token}\r\n`, '-i', input]
const frames = async (input: string, token?: string) => {
  const { stdout } = await sh('ffprobe', [...args(input, token), '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0'])
  return Number(stdout.split('\n').find((l) => l.trim()))
}

describe('real ffmpeg against our encrypted HLS', () => {
  it('decodes every frame when the key server hands out the right keys', async () => {
    hits.length = 0
    mode.keys = 'ok'
    expect(await frames(`${base}/index.m3u8`)).toBe(350)
    // one key per group, fetched from the key route and nowhere else
    expect([...new Set(hits)].sort()).toEqual(['/key/0', '/key/1', '/key/2'])
  })

  it('stores nothing a player can use without the key', async () => {
    const seg = await readFile(join(dir, 'served', 'seg_00000.ts'))
    expect(seg[0]).not.toBe(0x47) // an MPEG-TS packet would start with the sync byte
    await expect(sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', join(dir, 'served', 'seg_00000.ts')])).rejects.toThrow(/Invalid data/)
  })

  it('fails when the key route refuses', async () => {
    mode.keys = 'refuse'
    await expect(frames(`${base}/index.m3u8`)).rejects.toThrow()
  })

  it('fails without the token', async () => {
    mode.keys = 'ok'
    await expect(frames(`${base}/index.m3u8`, 'nope')).rejects.toThrow()
  })

  it('does not decode to the real video with a wrong key', async () => {
    mode.keys = 'wrong'
    const got = await frames(`${base}/index.m3u8`).catch(() => 0)
    expect(got).toBeLessThan(350)
    mode.keys = 'ok'
  })
})
