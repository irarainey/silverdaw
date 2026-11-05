import { reportSchema, type FrameSummary, type Report } from './contracts.ts'

function sortedMeasurements(values: readonly number[]): number[] {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Expected nonempty, finite, nonnegative measurements')
  }
  return [...values].sort((a, b) => a - b)
}

function median(values: readonly number[]): number {
  const sorted = sortedMeasurements(values)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function percentile(values: readonly number[], fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error('Expected percentile fraction in (0, 1]')
  }
  const sorted = sortedMeasurements(values)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

export function summarizeFrames(values: readonly number[]): FrameSummary {
  return {
    count: values.length,
    medianMs: median(values),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: percentile(values, 1)
  }
}

export function compareReports(before: Report, after: Report): object {
  reportSchema.parse(before)
  reportSchema.parse(after)
  if (
    before.status !== 'passed' ||
    after.status !== 'passed' ||
    !before.runs.length ||
    !after.runs.length
  ) {
    throw new Error('Cannot compare failed or empty benchmark reports')
  }
  for (const [label, a, b] of [
    ['workload version', before.workloadVersion, after.workloadVersion],
    ['fixture', before.scenario.fingerprint, after.scenario.fingerprint],
    ['environment', before.environment, after.environment],
    ['configuration', before.config, after.config]
  ]) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Incompatible ${label}`)
  }
  const metrics: Record<string, (run: Report['runs'][number]) => number> = {
    openToShellPaintMs: (run) => run.openToShellPaintMs,
    idleFrameP95Ms: (run) => run.idleFrames.p95Ms,
    scrollFrameP95Ms: (run) => run.scrollFrames.p95Ms,
    scrollFrameP99Ms: (run) => run.scrollFrames.p99Ms,
    zoomFrameP95Ms: (run) => run.zoomFrames.p95Ms,
    peakSampledPrivateMiB: (run) =>
      Math.max(
        ...run.resources.map(
          (sample) => sample.reduce((sum, item) => sum + item.privateBytes, 0) / 1024 ** 2
        )
      ),
    sampledCpuMs: (run) =>
      run.resources[run.resources.length - 1].reduce((sum, item) => sum + item.cpuMs, 0) -
      run.resources[0].reduce((sum, item) => sum + item.cpuMs, 0),
    bridgeReceivedBytes: (run) => run.bridgeReceived.bytes
  }
  return {
    beforeBuild: before.build.fingerprint,
    afterBuild: after.build.fingerprint,
    beforeRuns: before.runs.length,
    afterRuns: after.runs.length,
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([name, select]) => {
        const a = before.runs.map(select)
        const b = after.runs.map(select)
        const baseline = median(a)
        const candidate = median(b)
        return [
          name,
          {
            baselineMedian: baseline,
            candidateMedian: candidate,
            changePercent: baseline === 0 ? null : (candidate / baseline - 1) * 100,
            baselineRange: [Math.min(...a), Math.max(...a)],
            candidateRange: [Math.min(...b), Math.max(...b)]
          }
        ]
      })
    )
  }
}
