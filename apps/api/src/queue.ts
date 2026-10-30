import { FlowProducer, Queue } from 'bullmq'
import { config } from './config.js'
import { connectionOptions } from './redis.js'
import type { Rung } from '../../worker/src/media.js'

export const QUEUE = { probe: 'probe', encode: 'encode', finalize: 'finalize', understand: 'understand' } as const

// BullMQ rejects ':' in custom job ids
export const jobId = {
  probe: (id: string, run: number) => `probe-${id}-${run}`,
  encode: (id: string, run: number, height: number) => `encode-${id}-${run}-${height}`,
  finalize: (id: string, run: number) => `finalize-${id}-${run}`,
  understand: (id: string, run: number, uRun: number) => `understand-${id}-${run}-${uRun}`,
}

export interface ProbeData {
  videoId: string
  run: number
}
export interface UnderstandData extends ProbeData {
  uRun: number
}
export interface EncodeData extends ProbeData {
  rung: Rung
  hasAudio: boolean
  duration: number
}

const keep = { removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 7 * 86400 } }

export function createQueues(url = config.redisUrl, prefix = config.queuePrefix) {
  const connection = connectionOptions(url)
  const defaultJobOptions = {
    ...keep,
    attempts: config.worker.attempts,
    backoff: { type: 'exponential', delay: config.worker.backoffMs },
  }
  const make = (name: string) => new Queue(name, { connection, prefix, defaultJobOptions })
  const probe = make(QUEUE.probe)
  const encode = make(QUEUE.encode)
  const finalize = make(QUEUE.finalize)
  const understand = make(QUEUE.understand)
  const flow = new FlowProducer({ connection, prefix })

  return {
    probe,
    encode,
    finalize,
    understand,
    flow,
    connection,
    prefix,
    // the job id makes this safe to call twice for the same run
    async enqueueProbe(videoId: string, run: number) {
      await probe.add('probe', { videoId, run } satisfies ProbeData, { jobId: jobId.probe(videoId, run) })
    },
    async enqueueUnderstand(videoId: string, run: number, uRun: number) {
      await understand.add('understand', { videoId, run, uRun } satisfies UnderstandData, {
        jobId: jobId.understand(videoId, run, uRun),
        attempts: config.ai.attempts,
        backoff: { type: 'exponential', delay: config.ai.backoffMs },
      })
    },
    async close() {
      await Promise.all([probe.close(), encode.close(), finalize.close(), understand.close(), flow.close()])
    },
  }
}

export type Queues = ReturnType<typeof createQueues>
