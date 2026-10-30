import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeCheck, makeSource, makeStack, type Stack, until } from './stack.js'

let s: Stack
let alice: Awaited<ReturnType<Stack['signup']>>
const dir = join(process.env.TMP_DIR!, 'kill')
const tmpA = join(dir, 'tmp-a')
const big = join(dir, 'big.mp4')
const children: ChildProcess[] = []

// a real worker process, in its own process group so one kill takes ffmpeg down with it
function startWorker(tmp: string) {
  const child = spawn('node', ['--import', 'tsx', 'apps/worker/src/index.ts'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MONGODB_URI: s.mongod.getUri('it'), TMP_DIR: tmp, WORKER_LOCK_MS: '3000', ENCODE_CONCURRENCY: '1' },
  })
  children.push(child)
  return child
}

beforeAll(async () => {
  await mkdir(tmpA, { recursive: true })
  await makeSource(big, { seconds: 40, size: '1920x1080' })
  s = await makeStack({ workers: false })
  alice = await s.signup('alice@example.com')
})
afterAll(async () => {
  for (const c of children) if (c.pid) try { process.kill(-c.pid, 'SIGKILL') } catch { /* already gone */ }
  await s.close()
  await rm(dir, { recursive: true, force: true })
})

describe('worker killed mid-encode', () => {
  it('is taken over by another worker and the video still comes out complete', async () => {
    const { id } = await s.send(alice, big, 'long.mp4')
    const a = startWorker(tmpA)

    const before = await until(async () => {
      const v = await s.videoCol.findOne({ _id: id })
      return v?.renditions?.some((r) => r.progress >= 10 && r.progress < 100) ? v : undefined
    }, 90_000)
    const midway = before.renditions!.find((r) => r.progress > 0 && r.progress < 100)!
    expect(before.status).toBe('processing')

    process.kill(-a.pid!, 'SIGKILL')
    await new Promise((r) => a.once('exit', r))
    // a hard kill cannot clean up: that is what the startup sweep is for
    expect((await readdir(tmpA)).filter((n) => n.startsWith('sv-')).length).toBeGreaterThan(0)

    startWorker(join(dir, 'tmp-b'))
    const v = await s.waitFor(id, 'ready', 240_000)
    expect(v.renditions!.map((r) => r.height)).toEqual([1080, 720, 480, 360])

    // proof that a takeover happened rather than a lucky finish
    const jobs = (await s.queues.encode.getJobs(['completed'])).filter((j) => j.data.videoId === id)
    const taken = jobs.find((j) => j.data.rung.height === midway.height)!
    expect(taken.stalledCounter).toBeGreaterThanOrEqual(1)

    // 40 s at 6 s segments is 7 files, numbered with no gap and no extra
    const expected = Array.from({ length: 7 }, (_, i) => `seg_${String(i).padStart(5, '0')}.ts`)
    for (const r of v.renditions!) {
      const names = (await s.keys(`hls/${id}/${r.height}/`)).map((k) => k.split('/').pop())
      expect(names).toEqual(['index.m3u8', ...expected])
      expect(r.segments).toBe(7)
    }

    const out = await decodeCheck(s, alice, id)
    // 7 segments, a new key every 5: two keys, each fetched once
    expect([...new Set(out.keyOpens)].sort()).toEqual([0, 1])
    expect(out.duration).toBeGreaterThan(39.5)
    expect(out.duration).toBeLessThan(41)
    for (const c of children) if (c.pid) try { process.kill(c.pid, 'SIGTERM') } catch { /* gone */ }
  })
})
