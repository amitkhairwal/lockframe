import { Worker } from 'bullmq'
import { config } from '../../api/src/config.js'
import { QUEUE } from '../../api/src/queue.js'
import { pipeline, type Deps } from './pipeline.js'
import { understanding } from './understand.js'
import type { Ai } from '../../api/src/ai.js'
import type { UnderstandStore } from '../../api/src/understand.js'

// Starts the three workers. The caller owns the connections in deps.
export async function startWorkers(deps: Deps & { ai?: Ai | null; understandStore?: UnderstandStore }, o: { encodeConcurrency?: number; lockMs?: number } = {}) {
  const p = pipeline({ ...deps, understand: { enabled: !!deps.ai && !!deps.understandStore } })
  const u = deps.understandStore ? understanding({ videos: deps.videos, store: deps.understandStore, ai: deps.ai ?? null, storage: deps.storage, tmpPrefix: 'sv-' }) : null
  await p.sweepTemp()

  const base = {
    connection: deps.queues.connection,
    prefix: deps.queues.prefix,
    lockDuration: o.lockMs ?? config.worker.lockMs,
    stalledInterval: o.lockMs ?? config.worker.lockMs,
    maxStalledCount: 3,
    // an idle worker waits on Redis this long between checks
    drainDelay: 30,
  }
  const workers = [
    new Worker(QUEUE.probe, (job) => p.probeJob(job), { ...base, concurrency: 4 }),
    new Worker(QUEUE.encode, (job, token) => p.encodeJob(job, token), { ...base, concurrency: o.encodeConcurrency ?? config.worker.encodeConcurrency }),
    new Worker(QUEUE.finalize, (job) => p.finalizeJob(job), { ...base, concurrency: 4 }),
    ...(u ? [new Worker(QUEUE.understand, (job) => u.job(job), { ...base, concurrency: 1 })] : []),
  ]
  for (const w of workers) {
    w.on('failed', (job, err) => void (w.name === QUEUE.understand ? (job ? u!.failed(job as never, err) : Promise.resolve()) : p.onFailed(job, err)).catch((e) => console.error('onFailed:', e)))
    w.on('error', (err) => console.error(`${w.name} worker:`, err.message))
  }

  return {
    async close() {
      p.stop()
      await Promise.all(workers.map((w) => w.close()))
    },
  }
}
