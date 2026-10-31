// One-time bucket setup: creates the bucket if it is missing, browser CORS for direct part uploads, and a lifecycle rule
// that drops abandoned multipart uploads. Same S3_* env vars as the API.
// CORS_ORIGINS is a comma separated list (default: the Vite dev server).
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand, S3Client } from '@aws-sdk/client-s3'
import { config } from '../apps/api/src/config.js'

const { endpoint, region, bucket, accessKey, secretKey } = config.s3
const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
})
const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',')

// create only when missing: a key scoped to one bucket (Backblaze B2) may not create buckets at all
await s3.send(new HeadBucketCommand({ Bucket: bucket })).catch(async (e) => {
  if (e?.$metadata?.httpStatusCode !== 404) throw e
  await s3.send(new CreateBucketCommand({ Bucket: bucket }))
})

await s3.send(
  new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  }),
)
console.log('cors set for', origins.join(', '))

await s3.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'abort-stale-multipart',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
        },
      ],
    },
  }),
)
console.log('lifecycle set: incomplete uploads abort after 2 days')
