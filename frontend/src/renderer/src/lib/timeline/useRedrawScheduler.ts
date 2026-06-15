// Coalesces many redraw requests into a single redraw per animation frame.
//
// The timeline's `redraw()` is a full scene rebuild whose cost scales with the
// visible waveform geometry. Zoom, scroll, drag, and a fan-out of Pinia watchers
// can each request a redraw multiple times within one input frame, so calling
// `redraw()` synchronously per request rebuilds the scene several times before
// the renderer ever paints. Routing those requests through this scheduler
// collapses a burst into exactly one rebuild on the next animation frame.

export interface RedrawScheduler {
  /** Request a redraw on the next animation frame; repeated calls coalesce. */
  schedule: () => void
  /** Run a pending redraw synchronously now and drop the queued frame. */
  flush: () => void
  /** Drop any queued redraw without running it (teardown). */
  cancel: () => void
}

export interface RedrawSchedulerOptions {
  /** Frame scheduler; defaults to `requestAnimationFrame`. Injectable for tests. */
  requestFrame?: (cb: FrameRequestCallback) => number
  /** Frame canceller; defaults to `cancelAnimationFrame`. Injectable for tests. */
  cancelFrame?: (handle: number) => void
}

export function createRedrawScheduler(
  redraw: () => void,
  options: RedrawSchedulerOptions = {}
): RedrawScheduler {
  const requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))

  let frame: number | null = null

  function run(): void {
    frame = null
    redraw()
  }

  function schedule(): void {
    if (frame !== null) return
    frame = requestFrame(run)
  }

  function flush(): void {
    if (frame === null) return
    cancelFrame(frame)
    run()
  }

  function cancel(): void {
    if (frame === null) return
    cancelFrame(frame)
    frame = null
  }

  return { schedule, flush, cancel }
}
