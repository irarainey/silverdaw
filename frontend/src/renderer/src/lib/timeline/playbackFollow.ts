// Pure scroll maths for playback auto-follow, split out of the playhead renderer
// so the decision can be reasoned about (and tested) without a Pixi application.
//
// Two modes share one easing curve:
//
//  - **Steady-state follow**, the normal case. Forward only: playback never runs
//    backwards, and easing backwards introduces scroll jitter.
//  - **Recovery**, entered on the frame follow begins if the playhead is off
//    screen — which is what zooming or panning while stopped leaves behind.
//    Steady-state follow could never bring back a playhead sitting *behind* the
//    view, and would only crawl toward one far ahead. Recovery therefore eases
//    in either direction until the view is centred on the playhead, then hands
//    back to steady-state follow. It is a smooth scroll rather than a jump,
//    because a jump reads as a glitch rather than as the view catching up.

/** Scroll offsets closer than this to the target count as arrived. */
const SETTLE_PX = 0.5

export interface FollowFrameParams {
  /** Absolute x of the playhead in content space, including the header offset. */
  playheadX: number
  /** Current horizontal scroll offset. */
  scrollX: number
  /** Width of the track area plus the header, i.e. the right edge of the view. */
  viewportWidth: number
  /** Width of the fixed track-header gutter on the left. */
  headerWidth: number
  /** Current zoom, used to scale the catch-up rate to playback speed. */
  pxPerSecond: number
  /** Wall-clock seconds since the previous follow frame. */
  dtSec: number
  /** True only on the frame follow starts, which can begin a recovery scroll. */
  startedFollowing: boolean
  /** True while a recovery scroll from a previous frame is still running. */
  recovering: boolean
}

export interface FollowFrame {
  /** Next scroll offset, or `null` when the view should not move this frame. */
  scrollX: number | null
  /** Whether a recovery scroll is still in progress after this frame. */
  recovering: boolean
}

/** Scroll offset that centres the playhead in the track area. */
export function followTargetScrollX(params: {
  playheadX: number
  viewportWidth: number
  headerWidth: number
}): number {
  const { playheadX, viewportWidth, headerWidth } = params
  const viewportCentre = headerWidth + (viewportWidth - headerWidth) / 2
  return Math.max(0, playheadX - viewportCentre)
}

/** True when the playhead sits outside the visible track area. */
export function isPlayheadOffScreen(params: {
  playheadX: number
  scrollX: number
  viewportWidth: number
  headerWidth: number
}): boolean {
  const viewportX = params.playheadX - params.scrollX
  return viewportX < params.headerWidth || viewportX > params.viewportWidth
}

/**
 * Distance to travel this frame: proportional to the remaining gap so the
 * scroll decelerates into the target, with a playback-relative floor so it
 * never falls behind the audio, and capped at the gap so it cannot overshoot.
 */
function stepPx(gap: number, pxPerSecond: number, dtSec: number): number {
  const magnitude = Math.abs(gap)
  const ratePxPerSec = Math.max(pxPerSecond * 3, magnitude * 5)
  return Math.min(magnitude, ratePxPerSec * dtSec)
}

/** Resolve one frame of auto-follow scrolling. The caller clamps the result. */
export function followFrame(params: FollowFrameParams): FollowFrame {
  const { playheadX, scrollX, viewportWidth, headerWidth, pxPerSecond, dtSec } = params
  const view = { playheadX, scrollX, viewportWidth, headerWidth }
  const desired = followTargetScrollX(view)
  const gap = desired - scrollX

  const recovering =
    (params.recovering || (params.startedFollowing && isPlayheadOffScreen(view))) &&
    Math.abs(gap) > SETTLE_PX

  if (recovering) {
    const magnitude = stepPx(gap, pxPerSecond, dtSec)
    if (magnitude <= 0) return { scrollX: null, recovering: true }
    return { scrollX: scrollX + (gap > 0 ? magnitude : -magnitude), recovering: true }
  }

  if (gap <= SETTLE_PX) return { scrollX: null, recovering: false }
  const magnitude = stepPx(gap, pxPerSecond, dtSec)
  return { scrollX: magnitude > 0 ? scrollX + magnitude : null, recovering: false }
}
