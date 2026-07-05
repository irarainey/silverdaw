// Smooths the coarse, bursty backend stem-separation progress into a continuously-moving bar.
//
// The backend reports real progress only once per inference chunk, and on a slow machine a chunk
// can take over a minute — so a bar bound directly to the reported percent freezes for ages then
// jumps. This layer keeps the bar visibly and *honestly* moving: it snaps up to each real value as
// it arrives, then between milestones it creeps at the pace actually observed so far (the size of
// the last real jump over the time it took), aiming to arrive at the projected next milestone just
// as it lands. Before any pace has been observed (the first chunk) it falls back to a gentle
// default creep. Purely presentational — the smoothed value is never sent back or persisted.

import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'

// Cold-start creep (percent per second) used only until a real milestone gap has been observed.
// Kept gentle so the bar can't sprint ahead of a slow job before its true pace is known.
const DEFAULT_TRICKLE_PER_SEC = 0.4
// Cold-start creep cap: at most this far above the last real percent before any pace is known.
// Deliberately small — a large headroom lets the bar overshoot on a slow first chunk and then
// sit frozen for minutes while the real value catches up (the "stuck at 28%" bug).
const DEFAULT_TRICKLE_HEADROOM = 4
// Never trickle past this (only reaching 100 once the job is finalising).
const TRICKLE_MAX = 98
// Clamp the observed pace to sane bounds so a tiny/instant milestone gap can't make the bar race
// or stall completely.
const MIN_OBSERVED_PACE = 0.1
const MAX_OBSERVED_PACE = 10
// Ease speeds (fraction of the remaining gap per second) for snapping up to a real milestone and
// for the final drive to 100.
const CATCHUP_PER_SEC = 8
const DONE_PER_SEC = 8

/** Per-step creep tuning derived from the observed milestone pace (omitted during cold start). */
export interface SmoothStepConfig {
  /** Creep rate toward the projected next milestone (percent per second). */
  tricklePerSec: number
  /** Upper bound the creep may approach before the next real milestone arrives. */
  cap: number
}

/** Pure per-frame step: advance `current` toward `target` given `done`, elapsed `dt` seconds, and
 * optional pace `config`. Without `config` it uses the gentle cold-start defaults. */
export function nextSmoothProgress(
  current: number,
  target: number,
  done: boolean,
  dt: number,
  config?: SmoothStepConfig
): number {
  const clampedTarget = Math.min(100, Math.max(0, target))
  const step = Math.max(0, dt)
  let v = Math.max(0, current)

  if (done) {
    v += (100 - v) * Math.min(1, step * DONE_PER_SEC)
    return v > 99.6 ? 100 : v
  }
  if (clampedTarget > v) {
    // Snap up to a freshly-delivered real milestone (fast), never overshooting it.
    v += Math.max(step * 2, (clampedTarget - v) * Math.min(1, step * CATCHUP_PER_SEC))
    return Math.min(clampedTarget, v)
  }
  // Steady creep between milestones: at the observed pace toward the projected next milestone, or
  // the gentle cold-start defaults until a pace is known.
  const trickle = Math.max(0, config?.tricklePerSec ?? DEFAULT_TRICKLE_PER_SEC)
  const cap = Math.min(TRICKLE_MAX, config?.cap ?? clampedTarget + DEFAULT_TRICKLE_HEADROOM)
  if (v < cap) v = Math.min(cap, v + step * trickle)
  return v
}

export interface SmoothProgressOptions {
  /** Real 0..100 progress reported by the backend. */
  target: () => number
  /** True while a job is in progress (drives start/stop + reset of the animation). */
  active: () => boolean
  /** True once the job is finalising (write stage) so the bar drives to 100. */
  done: () => boolean
}

/** Animated, continuously-moving progress percent for the stem-separation dialog. */
export function useSmoothProgress(opts: SmoothProgressOptions): { displayPercent: Ref<number> } {
  const displayPercent = ref(0)
  let raf: number | null = null
  let lastTs = 0
  // Milestone-pace tracking (all in the rAF timebase; seconds).
  let lastRealTarget = 0
  let lastRealSec = 0
  let observedPace = 0
  let projectedCap = 0

  const resetPace = (): void => {
    lastRealTarget = 0
    lastRealSec = 0
    observedPace = 0
    projectedCap = 0
  }

  const frame = (ts: number): void => {
    const dt = lastTs > 0 ? Math.min(0.1, (ts - lastTs) / 1000) : 0.016
    lastTs = ts
    const target = opts.target()

    // On each genuine forward milestone, measure the pace from the previous one and project the
    // next milestone to be a similar jump — so the creep aims to arrive there right on time.
    if (target > lastRealTarget + 1e-6) {
      const nowSec = ts / 1000
      const deltaPct = target - lastRealTarget
      if (lastRealSec > 0) {
        const interval = Math.max(0.001, nowSec - lastRealSec)
        observedPace = Math.min(MAX_OBSERVED_PACE, Math.max(MIN_OBSERVED_PACE, deltaPct / interval))
        projectedCap = Math.min(TRICKLE_MAX, target + deltaPct)
      }
      lastRealTarget = target
      lastRealSec = nowSec
    }

    const config =
      observedPace > 0 ? { tricklePerSec: observedPace, cap: projectedCap } : undefined
    displayPercent.value = nextSmoothProgress(displayPercent.value, target, opts.done(), dt, config)
    raf = requestAnimationFrame(frame)
  }

  const stop = (): void => {
    if (raf !== null) {
      cancelAnimationFrame(raf)
      raf = null
    }
  }

  watch(
    opts.active,
    (isActive) => {
      if (isActive) {
        if (raf === null) {
          lastTs = 0
          displayPercent.value = 0
          resetPace()
          raf = requestAnimationFrame(frame)
        }
      } else {
        stop()
        displayPercent.value = 0
        resetPace()
      }
    },
    { immediate: true }
  )

  if (getCurrentScope()) onScopeDispose(stop)
  return { displayPercent }
}
