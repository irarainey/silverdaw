import { describe, it, expect, vi } from 'vitest'
import { createRedrawScheduler } from '@/lib/timeline/useRedrawScheduler'

/**
 * Drives a deterministic stand-in for `requestAnimationFrame` so the coalescing
 * behaviour can be asserted without a real frame loop.
 */
function createFakeFrames() {
  let nextHandle = 1
  const pending = new Map<number, FrameRequestCallback>()
  return {
    requestFrame: (cb: FrameRequestCallback): number => {
      const handle = nextHandle++
      pending.set(handle, cb)
      return handle
    },
    cancelFrame: (handle: number): void => {
      pending.delete(handle)
    },
    /** Run every queued callback once, mimicking a single animation frame. */
    tick: (): void => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const cb of callbacks) cb(0)
    },
    pendingCount: (): number => pending.size
  }
}

describe('createRedrawScheduler', () => {
  it('coalesces multiple schedule() calls into one redraw per frame', () => {
    const frames = createFakeFrames()
    const redraw = vi.fn()
    const scheduler = createRedrawScheduler(redraw, frames)

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()
    expect(redraw).not.toHaveBeenCalled()
    expect(frames.pendingCount()).toBe(1)

    frames.tick()
    expect(redraw).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh redraw to be scheduled after the frame runs', () => {
    const frames = createFakeFrames()
    const redraw = vi.fn()
    const scheduler = createRedrawScheduler(redraw, frames)

    scheduler.schedule()
    frames.tick()
    scheduler.schedule()
    frames.tick()

    expect(redraw).toHaveBeenCalledTimes(2)
  })

  it('flush() runs a pending redraw immediately and drops the queued frame', () => {
    const frames = createFakeFrames()
    const redraw = vi.fn()
    const scheduler = createRedrawScheduler(redraw, frames)

    scheduler.schedule()
    scheduler.flush()
    expect(redraw).toHaveBeenCalledTimes(1)
    expect(frames.pendingCount()).toBe(0)

    // The dropped frame must not fire a second redraw.
    frames.tick()
    expect(redraw).toHaveBeenCalledTimes(1)
  })

  it('flush() is a no-op when nothing is pending', () => {
    const frames = createFakeFrames()
    const redraw = vi.fn()
    const scheduler = createRedrawScheduler(redraw, frames)

    scheduler.flush()
    expect(redraw).not.toHaveBeenCalled()
  })

  it('cancel() drops a queued redraw without running it', () => {
    const frames = createFakeFrames()
    const redraw = vi.fn()
    const scheduler = createRedrawScheduler(redraw, frames)

    scheduler.schedule()
    scheduler.cancel()
    frames.tick()

    expect(redraw).not.toHaveBeenCalled()
    expect(frames.pendingCount()).toBe(0)
  })
})
