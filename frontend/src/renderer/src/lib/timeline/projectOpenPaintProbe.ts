// Measures how long the timeline canvas takes to show a freshly opened project.
//
// The track headers are Vue DOM and appear as soon as the snapshot lands, while the
// lanes, clips, and waveforms are a Pixi rebuild scheduled on the next animation
// frame. Any work that starves that frame is visible as headers-without-lanes, but
// nothing in the logs spans the two, which is what this probe records.
import { log } from '@/lib/log'

let pendingLabel: string | null = null
let pendingAtMs = 0

/** Arm the probe when a project snapshot is applied. */
export function markProjectSnapshotApplied(label: string): void {
  pendingLabel = label
  pendingAtMs = performance.now()
}

/** Report the first timeline rebuild that completes after a snapshot, then disarm. */
export function reportFirstTimelinePaint(rows: number, clips: number): void {
  if (pendingLabel === null) return
  const elapsedMs = performance.now() - pendingAtMs
  const label = pendingLabel
  pendingLabel = null
  log.info(
    'perf.timeline',
    `first paint after project snapshot in ${elapsedMs.toFixed(1)}ms rows=${rows} clips=${clips} name=${label}`
  )
}

/** Test seam: drop an armed probe so one test can't leak into the next. */
export function resetProjectOpenPaintProbe(): void {
  pendingLabel = null
  pendingAtMs = 0
}
