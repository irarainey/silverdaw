// Smooths the coarse, bursty backend stem-separation progress into a continuously-moving bar.
//
// The backend emits fine-grained progress, but over the loopback websocket those messages are
// buffered during sustained inference and only flush in a burst at each stem boundary — so a bar
// bound directly to the reported percent freezes for ~20 s then jumps. This layer keeps the bar
// visibly moving: it creeps forward at a steady, capped rate between milestones and snaps up to
// each real value as it arrives, so the user always sees "work happening". Purely presentational —
// the smoothed value is never sent back or persisted.

import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'

// Steady creep rate (percent per second) while waiting for the next real milestone. Roughly the
// job's average pace, so the bar reads as genuine progress rather than a spinner.
const TRICKLE_PER_SEC = 1.5
// The creep is capped this far above the last real percent so the bar can't run far ahead of
// reality during a long, quiet stem (it slows to a stop near the cap until the next milestone).
const TRICKLE_HEADROOM = 30
// Never trickle past this (only reaching 100 once the job is finalising).
const TRICKLE_MAX = 98
// Ease speeds (fraction of the remaining gap per second) for snapping up to a real milestone and
// for the final drive to 100.
const CATCHUP_PER_SEC = 8
const DONE_PER_SEC = 8

/** Pure per-frame step: advance `current` toward `target` given `done` and elapsed `dt` seconds. */
export function nextSmoothProgress(current: number, target: number, done: boolean, dt: number): number {
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
  // Steady, capped creep between milestones so the bar keeps moving.
  const cap = Math.min(TRICKLE_MAX, clampedTarget + TRICKLE_HEADROOM)
  if (v < cap) v = Math.min(cap, v + step * TRICKLE_PER_SEC)
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

  const frame = (ts: number): void => {
    const dt = lastTs > 0 ? Math.min(0.1, (ts - lastTs) / 1000) : 0.016
    lastTs = ts
    displayPercent.value = nextSmoothProgress(displayPercent.value, opts.target(), opts.done(), dt)
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
          raf = requestAnimationFrame(frame)
        }
      } else {
        stop()
        displayPercent.value = 0
      }
    },
    { immediate: true }
  )

  if (getCurrentScope()) onScopeDispose(stop)
  return { displayPercent }
}
