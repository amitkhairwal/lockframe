import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../apps/api/src/config.js'
import { harness, type Harness } from './harness.js'

let h: Harness
const dir = mkdtempSync(join(tmpdir(), 'sv-web-'))

beforeAll(async () => {
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<title>player</title>')
  writeFileSync(join(dir, 'assets', 'app-1.js'), 'console.log(1)')
  writeFileSync(join(dir, '..', 'sv-secret.txt'), 'secret')
  config.webDir = dir
  h = await harness()
})
afterAll(async () => {
  await h.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(join(dir, '..', 'sv-secret.txt'), { force: true })
})

const get = (path: string) => fetch(h.api + path)

describe('built player', () => {
  it('serves index.html at the root and for page routes', async () => {
    for (const path of ['/', '/library', '/watch/abc?x=1']) {
      const res = await get(path)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<title>player</title>')
    }
  })

  it('serves assets with the right type and a long cache', async () => {
    const res = await get('/assets/app-1.js')
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('keeps api and media paths as plain 404s, not the page', async () => {
    for (const path of ['/api/nope', '/media/nope', '/media/x/master.m3u8']) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('<title>')
    }
  })

  it('does not read outside the folder', async () => {
    for (const path of ['/..%2Fsv-secret.txt', '/%2e%2e/sv-secret.txt', '/assets/..%2F..%2Fsv-secret.txt']) {
      const res = await get(path)
      expect(await res.text()).not.toContain('secret')
    }
  })

  it('does not answer other methods with the page', async () => {
    expect((await fetch(h.api + '/library', { method: 'POST' })).status).toBe(404)
  })
})
