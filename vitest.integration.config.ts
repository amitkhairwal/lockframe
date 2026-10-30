import { defineConfig } from 'vitest/config'

// Needs real S3, Redis and ffmpeg. See docs/DEV.md for the env vars.
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      QUEUE_PREFIX: `it${Date.now()}`,
      JOB_ATTEMPTS: '2',
      JOB_BACKOFF_MS: '200',
      PART_BYTES: String(5 * 1024 * 1024),
      MAX_UPLOAD_BYTES: String(2 * 1024 * 1024 * 1024),
      TMP_DIR: `/tmp/sv-it-tmp-${process.pid}`,
    },
  },
})
