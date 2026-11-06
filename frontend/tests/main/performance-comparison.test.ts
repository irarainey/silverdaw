import { describe, expect, it } from 'vitest'
import { compareReports, summarizeFrames } from '../../performance/statistics.ts'
import type { Report } from '../../performance/contracts.ts'

function report(): Report {
  const hash = 'a'.repeat(64)
  const frames = summarizeFrames([10, 10, 20, 40])
  return {
    version: 1,
    workloadVersion: 1,
    scenario: {
      version: 1,
      scenario: { id: 'smoke', tracks: 8, clips: 32, voices: 2, sources: 2, clipMs: 2000 },
      projectFile: 'smoke.silverdaw',
      files: [
        { path: 'smoke.silverdaw', bytes: 100, sha256: hash },
        { path: 'tone-1.wav', bytes: 100, sha256: hash }
      ],
      fingerprint: hash
    },
    build: { fingerprint: hash, files: [], runtime: { app: '1.10.0' } },
    environment: {
      label: 'controlled',
      host: hash,
      os: 'Windows',
      cpu: 'test',
      logicalCpus: 8,
      totalMemory: 1000000000,
      gpu: null,
      renderer: null
    },
    config: {
      viewport: [1440, 900],
      warmupFrames: 60,
      idleFrames: 180,
      wheelSteps: 48,
      timeoutMs: 180000,
      maxPrivateMiB: 4096,
      resourceSampleMs: 1000,
      cacheMode: 'fresh-profile-project-os-cache-uncontrolled',
      logging: false
    },
    runs: [
      {
        openToShellPaintMs: 100,
        idleFrames: frames,
        scrollFrames: frames,
        zoomFrames: frames,
        resources: [
          [
            {
              pid: 123,
              sampleMs: 0,
              privateBytes: 1024,
              workingSetBytes: 4096,
              handles: 10,
              cpuMs: 100
            }
          ]
        ],
        bridgeReceived: { messages: 1, bytes: 100 },
        savedCounts: { tracks: 8, clips: 32, sources: 2 }
      }
    ],
    status: 'passed',
    cleanupWarnings: []
  }
}

describe('benchmark comparisons', () => {
  it('compares measurements while allowing build identities to differ', () => {
    const baseline = report()
    const candidate = report()
    candidate.build.fingerprint = 'b'.repeat(64)
    candidate.runs[0].openToShellPaintMs = 50
    expect(compareReports(baseline, candidate)).toMatchObject({
      metrics: {
        openToShellPaintMs: { baselineMedian: 100, candidateMedian: 50, changePercent: -50 }
      }
    })
  })

  it('uses the middle pair for an even number of repeated measurements', () => {
    const baseline = report()
    const candidate = report()
    baseline.runs.push({ ...baseline.runs[0], openToShellPaintMs: 300 })
    candidate.runs[0].openToShellPaintMs = 80
    candidate.runs.push({ ...candidate.runs[0], openToShellPaintMs: 120 })
    expect(compareReports(baseline, candidate)).toMatchObject({
      metrics: {
        openToShellPaintMs: {
          baselineMedian: 200,
          candidateMedian: 100,
          changePercent: -50,
          baselineRange: [100, 300],
          candidateRange: [80, 120]
        }
      }
    })
  })

  it.each(['fixture', 'environment', 'configuration', 'failed', 'empty'])(
    'rejects incompatible or unusable %s results',
    (reason) => {
      const candidate = report()
      if (reason === 'fixture') candidate.scenario.fingerprint = 'b'.repeat(64)
      if (reason === 'environment') candidate.environment.label = 'other machine'
      if (reason === 'configuration') candidate.config.viewport[0] = 1920
      if (reason === 'failed') candidate.status = 'failed'
      if (reason === 'empty') candidate.runs = []
      expect(() => compareReports(report(), candidate)).toThrow()
    }
  )
})
