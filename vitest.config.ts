import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: { PART_BYTES: String(1024 * 1024), MAX_UPLOAD_BYTES: String(100 * 1024 * 1024), NODE_ENV: 'test' },
  },
})
