import { z } from 'zod'

const integer = z.number().int().positive()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const fileSchema = z.object({
  path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  bytes: integer,
  sha256: hash
})

export const manifestSchema = z.object({
  version: z.literal(1),
  scenario: z.object({
    id: z.string(),
    tracks: integer,
    clips: integer,
    voices: integer,
    sources: integer,
    clipMs: integer,
    profile: z.enum(['varied-v1', 'chopped-v1', 'longform-v1']).optional()
  }),
  projectFile: z.string(),
  files: z.array(fileSchema).min(2),
  fingerprint: hash
})
export type Manifest = z.infer<typeof manifestSchema>

const frameSchema = z.object({
  count: integer,
  medianMs: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  p99Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative()
})
export type FrameSummary = z.infer<typeof frameSchema>

export const resourceSchema = z
  .array(
    z.object({
      pid: integer,
      sampleMs: z.number().nonnegative(),
      privateBytes: z.number().nonnegative(),
      workingSetBytes: z.number().nonnegative(),
      handles: z.number().int().nonnegative(),
      cpuMs: z.number().nonnegative()
    })
  )
  .min(1)
export type ResourceSample = z.infer<typeof resourceSchema>

export const reportSchema = z.object({
  version: z.literal(1),
  workloadVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  scenario: manifestSchema,
  build: z.object({
    fingerprint: hash,
    files: z.array(z.object({ path: z.string(), bytes: integer, sha256: hash })),
    runtime: z.record(z.string(), z.string())
  }),
  environment: z.object({
    label: z.string().min(1),
    host: z.string(),
    os: z.string(),
    cpu: z.string(),
    logicalCpus: integer,
    totalMemory: integer,
    gpu: z.unknown(),
    renderer: z.unknown()
  }),
  config: z.object({
    viewport: z.tuple([integer, integer]),
    warmupFrames: integer,
    idleFrames: integer,
    wheelSteps: integer,
    timeoutMs: integer,
    maxPrivateMiB: integer,
    resourceSampleMs: integer,
    cacheMode: z.literal('fresh-profile-project-os-cache-uncontrolled'),
    logging: z.literal(false)
  }),
  runs: z.array(
    z.object({
      openToShellPaintMs: z.number().nonnegative(),
      idleFrames: frameSchema,
      scrollFrames: frameSchema,
      zoomFrames: frameSchema,
      resources: z.array(resourceSchema).min(1),
      bridgeReceived: z.object({
        messages: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative()
      }),
      savedCounts: z.object({ tracks: integer, clips: integer, sources: integer })
    })
  ),
  cleanupWarnings: z.array(z.string()),
  failedAttempt: z
    .object({
      directory: z.string(),
      phase: z.string(),
      backendPids: z.array(integer),
      resources: z.array(resourceSchema),
      lifecycle: z.array(z.string())
    })
    .optional(),
  status: z.enum(['passed', 'failed']),
  error: z.string().optional()
})
export type Report = z.infer<typeof reportSchema>
