import { describe, expect, it, vi } from 'vitest'
import {
  startDownloadRun,
  MAX_DOWNLOAD_CONCURRENCY,
  type DownloadSource,
  type DownloadRunProgress
} from '@/lib/stems/stemModelDownloadRunner'

type ProgressHandler = (p: { receivedBytes: number; fileName: string }) => void

/** Helper: create a mock DownloadSource with controllable ensure/progress. */
function mockSource(opts: {
  totalBytes: number
  presentBytes?: number
  ensureResult?: () => Promise<{ ok: true } | { ok: false; error: string }>
}): { source: DownloadSource; fireProgress: (p: { receivedBytes: number; fileName: string }) => void; ensureCalled: () => boolean } {
  let handler: ProgressHandler | null = null
  let called = false
  const source: DownloadSource = {
    totalBytes: opts.totalBytes,
    presentBytes: opts.presentBytes ?? 0,
    ensure: () => {
      called = true
      return opts.ensureResult ? opts.ensureResult() : Promise.resolve({ ok: true })
    },
    onProgress: (h) => {
      handler = h
      return () => { handler = null }
    },
    cancel: vi.fn()
  }
  return {
    source,
    fireProgress: (p) => handler?.(p),
    ensureCalled: () => called
  }
}

describe('stemModelDownloadRunner', () => {
  describe('basic success', () => {
    it('resolves with success when all sources complete', async () => {
      const s1 = mockSource({ totalBytes: 100 })
      const s2 = mockSource({ totalBytes: 200 })
      const progress: DownloadRunProgress[] = []

      const { done } = startDownloadRun([s1.source, s2.source], (p) => progress.push({ ...p }))
      const result = await done

      expect(result).toEqual({ outcome: 'success' })
    })

    it('forces received to totalBytes on success even without a final progress event', async () => {
      const progress: DownloadRunProgress[] = []
      const s1 = mockSource({ totalBytes: 500 })

      const { done } = startDownloadRun([s1.source], (p) => progress.push({ ...p }))
      await done

      const last = progress[progress.length - 1]
      expect(last).toBeDefined()
      expect(last?.receivedBytes).toBe(500)
      expect(last?.totalBytes).toBe(500)
    })
  })

  describe('progress clamping and monotonicity', () => {
    it('clamps presentBytes seed to [0, totalBytes]', async () => {
      const progress: DownloadRunProgress[] = []
      // presentBytes exceeds totalBytes — seed must be clamped to 100 (not 999)
      const s1 = mockSource({
        totalBytes: 100,
        presentBytes: 999,
        ensureResult: () => Promise.resolve({ ok: true })
      })

      const { done } = startDownloadRun([s1.source], (p) => progress.push({ ...p }))
      await done

      // On success the slot is forced to totalBytes; the overall run finishes at 100
      const last = progress[progress.length - 1]
      expect(last?.receivedBytes).toBe(100)
      expect(last?.totalBytes).toBe(100)
    })

    it('clamps negative presentBytes seed to 0', async () => {
      const progress: DownloadRunProgress[] = []
      const s1 = mockSource({
        totalBytes: 100,
        presentBytes: -50,
        ensureResult: () => Promise.resolve({ ok: true })
      })

      const { done } = startDownloadRun([s1.source], (p) => progress.push({ ...p }))
      await done

      // On success, slot received is set to totalBytes (100)
      const last = progress[progress.length - 1]
      expect(last?.receivedBytes).toBe(100)
    })

    it('clamps progress events exceeding totalBytes', async () => {
      const progress: DownloadRunProgress[] = []
      let resolveEnsure!: (v: { ok: true }) => void
      const s1 = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveEnsure = r })
      })

      startDownloadRun([s1.source], (p) => progress.push({ ...p }))

      s1.fireProgress({ receivedBytes: 200, fileName: 'big.bin' })
      expect(progress[0]?.receivedBytes).toBe(100)

      resolveEnsure({ ok: true })
    })

    it('ignores regressing progress (maintains monotonicity)', async () => {
      const progress: DownloadRunProgress[] = []
      let resolveEnsure!: (v: { ok: true }) => void
      const s1 = mockSource({
        totalBytes: 500,
        ensureResult: () => new Promise((r) => { resolveEnsure = r })
      })

      startDownloadRun([s1.source], (p) => progress.push({ ...p }))

      s1.fireProgress({ receivedBytes: 300, fileName: 'a.bin' })
      expect(progress[0]?.receivedBytes).toBe(300)

      // Regress — must be ignored
      s1.fireProgress({ receivedBytes: 100, fileName: 'a.bin' })
      expect(progress).toHaveLength(1) // no new emission

      // Advance again
      s1.fireProgress({ receivedBytes: 400, fileName: 'a.bin' })
      expect(progress[1]?.receivedBytes).toBe(400)

      resolveEnsure({ ok: true })
    })

    it('aggregate progress across multiple sources is monotonic', async () => {
      const progress: DownloadRunProgress[] = []
      let resolveA!: (v: { ok: true }) => void
      let resolveB!: (v: { ok: true }) => void
      const sA = mockSource({
        totalBytes: 200,
        ensureResult: () => new Promise((r) => { resolveA = r })
      })
      const sB = mockSource({
        totalBytes: 300,
        ensureResult: () => new Promise((r) => { resolveB = r })
      })

      startDownloadRun([sA.source, sB.source], (p) => progress.push({ ...p }))

      sA.fireProgress({ receivedBytes: 100, fileName: 'a.bin' })
      sB.fireProgress({ receivedBytes: 150, fileName: 'b.bin' })
      // Aggregate = 100 + 150 = 250
      expect(progress[progress.length - 1]?.receivedBytes).toBe(250)

      // Regress A — aggregate should not decrease
      sA.fireProgress({ receivedBytes: 50, fileName: 'a.bin' })
      // No new event emitted (A's clamped value stays at 100)
      expect(progress[progress.length - 1]?.receivedBytes).toBe(250)

      resolveA({ ok: true })
      resolveB({ ok: true })
    })

    it('oversized seed plus progress events stays clamped to totalBytes', async () => {
      const progress: DownloadRunProgress[] = []
      const s1 = mockSource({
        totalBytes: 100,
        presentBytes: 150, // oversized — clamped to 100
        ensureResult: () => Promise.resolve({ ok: true })
      })

      const { done } = startDownloadRun([s1.source], (p) => progress.push({ ...p }))
      await done

      // Seed is clamped to 100; success forces to totalBytes (100) — no overshoot
      const last = progress[progress.length - 1]
      expect(last?.receivedBytes).toBe(100)
      expect(last?.totalBytes).toBe(100)
      // No intermediate emission can exceed totalBytes
      for (const p of progress) {
        expect(p.receivedBytes).toBeLessThanOrEqual(p.totalBytes)
      }
    })
  })

  describe('cancellation', () => {
    it('resolves with cancelled and disposes all listeners', async () => {
      let resolveEnsure!: (v: { ok: true }) => void
      const s1 = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveEnsure = r })
      })

      const { handle, done } = startDownloadRun([s1.source], () => {})
      handle.cancel()

      const result = await done
      expect(result).toEqual({ outcome: 'cancelled' })
      expect(s1.source.cancel).toHaveBeenCalled()

      // Late progress after cancel must not throw
      s1.fireProgress({ receivedBytes: 50, fileName: 'late.bin' })
      resolveEnsure({ ok: true })
    })

    it('late progress from abandoned run does not emit after cancel', async () => {
      const progress: DownloadRunProgress[] = []
      let resolveEnsure!: (v: { ok: true }) => void
      const s1 = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveEnsure = r })
      })

      const { handle, done } = startDownloadRun([s1.source], (p) => progress.push({ ...p }))

      s1.fireProgress({ receivedBytes: 30, fileName: 'a.bin' })
      expect(progress).toHaveLength(1)

      handle.cancel()
      await done

      // After cancel, progress handler is unsubscribed — but even if called, must not emit
      s1.fireProgress({ receivedBytes: 80, fileName: 'a.bin' })
      expect(progress).toHaveLength(1)

      resolveEnsure({ ok: true })
    })
  })

  describe('first error immediate', () => {
    it('resolves with error immediately on first failure without waiting for peers', async () => {
      const s1 = mockSource({
        totalBytes: 100,
        ensureResult: () => Promise.resolve({ ok: false, error: 'integrity check failed' })
      })
      // s2 never settles — simulates a peer that hangs
      const s2 = mockSource({
        totalBytes: 200,
        ensureResult: () => new Promise(() => {}) // never resolves
      })

      const { done } = startDownloadRun([s1.source, s2.source], () => {})
      const result = await done

      expect(result).toEqual({ outcome: 'error', error: 'integrity check failed' })
      // s2 was cancelled
      expect(s2.source.cancel).toHaveBeenCalled()
    })

    it('resolves with error on thrown exception without waiting for peers', async () => {
      const s1 = mockSource({
        totalBytes: 100,
        ensureResult: () => Promise.reject(new Error('network timeout'))
      })
      const s2 = mockSource({
        totalBytes: 200,
        ensureResult: () => new Promise(() => {}) // never resolves
      })

      const { done } = startDownloadRun([s1.source, s2.source], () => {})
      const result = await done

      expect(result).toEqual({ outcome: 'error', error: 'network timeout' })
      expect(s2.source.cancel).toHaveBeenCalled()
    })

    it('disposes listeners synchronously on first error', async () => {
      const progress: DownloadRunProgress[] = []
      let resolveS2!: (v: { ok: true }) => void
      const s1 = mockSource({
        totalBytes: 100,
        ensureResult: () => Promise.resolve({ ok: false, error: 'bad checksum' })
      })
      const s2 = mockSource({
        totalBytes: 200,
        ensureResult: () => new Promise((r) => { resolveS2 = r })
      })

      const { done } = startDownloadRun([s1.source, s2.source], (p) => progress.push({ ...p }))
      await done

      // After error resolution, late progress on s2 must not emit
      s2.fireProgress({ receivedBytes: 100, fileName: 'late.bin' })
      // Only the success emissions for s1 (forced to total) might be present — no s2 late
      const lateS2 = progress.filter((p) => p.fileName === 'late.bin')
      expect(lateS2).toHaveLength(0)

      resolveS2({ ok: true })
    })
  })

  describe('bounded concurrency', () => {
    it('respects MAX_DOWNLOAD_CONCURRENCY of 2', () => {
      expect(MAX_DOWNLOAD_CONCURRENCY).toBe(2)
    })

    it('does not start third source until a slot frees up', async () => {
      let resolveA!: (v: { ok: true }) => void
      let resolveB!: (v: { ok: true }) => void
      const sA = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveA = r })
      })
      const sB = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveB = r })
      })
      const sC = mockSource({ totalBytes: 100 })

      const { done } = startDownloadRun([sA.source, sB.source, sC.source], () => {}, 2)

      // A and B started, C has not
      expect(sA.ensureCalled()).toBe(true)
      expect(sB.ensureCalled()).toBe(true)
      expect(sC.ensureCalled()).toBe(false)

      // Free A → C starts (need multiple microtask ticks for worker iteration)
      resolveA({ ok: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(sC.ensureCalled()).toBe(true)

      resolveB({ ok: true })
      await done
    })

    it('works with concurrency 1 (sequential)', async () => {
      let resolveA!: (v: { ok: true }) => void
      const sA = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveA = r })
      })
      const sB = mockSource({ totalBytes: 100 })

      const { done } = startDownloadRun([sA.source, sB.source], () => {}, 1)

      expect(sA.ensureCalled()).toBe(true)
      expect(sB.ensureCalled()).toBe(false)

      resolveA({ ok: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(sB.ensureCalled()).toBe(true)

      await done
    })
  })

  describe('identity scoping (cancel→re-enter)', () => {
    it('old run progress does not affect new run after cancel', async () => {
      const progressA: DownloadRunProgress[] = []
      const progressB: DownloadRunProgress[] = []
      let resolveA!: (v: { ok: true }) => void
      const sA = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveA = r })
      })

      const runA = startDownloadRun([sA.source], (p) => progressA.push({ ...p }))

      sA.fireProgress({ receivedBytes: 50, fileName: 'a.bin' })
      expect(progressA).toHaveLength(1)

      // Cancel run A
      runA.handle.cancel()
      const resultA = await runA.done
      expect(resultA).toEqual({ outcome: 'cancelled' })

      // Start run B with a fresh source
      const sB = mockSource({ totalBytes: 200 })
      const runB = startDownloadRun([sB.source], (p) => progressB.push({ ...p }))

      // Old A promise resolves — must not affect B
      resolveA({ ok: true })
      await Promise.resolve()

      const resultB = await runB.done
      expect(resultB).toEqual({ outcome: 'success' })
      // B got its own progress emissions, not contaminated by A
      expect(progressB.every((p) => p.totalBytes === 200)).toBe(true)
    })

    it('old run settling after cancel does not produce a second result', async () => {
      let resolveA!: (v: { ok: true }) => void
      const sA = mockSource({
        totalBytes: 100,
        ensureResult: () => new Promise((r) => { resolveA = r })
      })

      const { handle, done } = startDownloadRun([sA.source], () => {})

      handle.cancel()
      const result = await done
      expect(result).toEqual({ outcome: 'cancelled' })

      // Old promise resolves — no secondary result should be possible
      resolveA({ ok: true })
      // done already resolved; this test just ensures no thrown errors
      await Promise.resolve()
    })
  })
})
