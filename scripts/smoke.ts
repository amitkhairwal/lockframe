// Smoke test for a running stack (compose here, or the deployed site).
// BASE (default http://localhost:3000). Exits non-zero on the first failed check.
// It uploads a 6 second generated clip, so ffmpeg must be on PATH where this runs.
import { execFileSync } from 'node:child_process'
import { openAsBlob } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upload, type FileLike } from '../shared/uploader.js'

const base = (process.env.BASE ?? 'http://localhost:3000').replace(/\/$/, '')
const stamp = Date.now()
const password = 'correct horse battery'

const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) process.exit(1)
}

async function signup(email: string) {
  const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  check(`signup ${email.split('@')[0]}`, res.status === 201, String(res.status))
  return { cookie: res.headers.getSetCookie()[0]!.split(';')[0]! }
}

const page = await fetch(base + '/')
check('player page is served', page.ok && (await page.text()).includes('<div id="root">'))
check('unknown api path is a 404, not the page', (await fetch(base + '/api/nope')).status === 404)

const owner = await signup(`smoke-owner-${stamp}@example.com`)
const stranger = await signup(`smoke-stranger-${stamp}@example.com`)

const dir = mkdtempSync(join(tmpdir(), 'sv-smoke-'))
const clip = join(dir, 'clip.mp4')
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-pix_fmt', 'yuv420p', '-shortest', clip])
const blob = await openAsBlob(clip, { type: 'video/mp4' })
const file = Object.assign(blob, { name: 'smoke.mp4', lastModified: 1 }) as FileLike
const { id } = await upload(file, { api: base, headers: { cookie: owner.cookie } })
check('upload finished', typeof id === 'string')

const api = (path: string, who: { cookie: string }, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { cookie: who.cookie, 'content-type': 'application/json', ...init.headers } })

let status = ''
for (let i = 0; i < 120 && status !== 'ready' && status !== 'failed'; i++) {
  status = ((await (await api(`/api/videos/${id}`, owner)).json()) as { status: string }).status
  if (status !== 'ready' && status !== 'failed') await new Promise((r) => setTimeout(r, 2000))
}
check('video reaches ready', status === 'ready', status)

const start = await api(`/api/videos/${id}/playback`, owner, { method: 'POST', body: '{}' })
check('owner starts playback', start.status === 200, String(start.status))
const play = (await start.json()) as { token: string; master: string }

const master = await fetch(play.master.startsWith('http') ? play.master : base + play.master)
const masterText = await master.text()
check('master playlist loads', master.ok && masterText.includes('#EXT-X-STREAM-INF'))
const variant = masterText.split('\n').find((l) => l.endsWith('index.m3u8'))!
const variantUrl = new URL(variant, new URL(play.master, base + '/'))
const list = await (await fetch(variantUrl)).text()
const keyUri = /URI="([^"]+)"/.exec(list)?.[1]
check('playlist points at a key', !!keyUri, keyUri)
const keyUrl = new URL(keyUri!, variantUrl)

check('key without a token is refused', (await fetch(keyUrl)).status === 401)
const key = await fetch(keyUrl, { headers: { authorization: `Bearer ${play.token}` } })
check('key with the token is 16 bytes', key.ok && (await key.arrayBuffer()).byteLength === 16)

const seg = new URL(list.split('\n').find((l) => l.endsWith('.ts'))!, variantUrl)
const bytes = new Uint8Array(await (await fetch(seg)).arrayBuffer())
check('segment is encrypted, not MPEG-TS', bytes.length > 0 && bytes[0] !== 0x47)

check('stranger cannot see the video', (await api(`/api/videos/${id}`, stranger)).status === 404)
check('stranger cannot start playback', (await api(`/api/videos/${id}/playback`, stranger, { method: 'POST', body: '{}' })).status === 404)

await api(`/api/videos/${id}`, owner, { method: 'DELETE' })
rmSync(dir, { recursive: true, force: true })
console.log('smoke test passed')
