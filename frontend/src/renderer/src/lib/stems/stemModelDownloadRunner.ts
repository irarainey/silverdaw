// Bounded-concurrency model download orchestration extracted from the stem
// separation flow. Owns run identity, cancel/listener disposal, aggregate
// progress with per-source clamping, and immediate-error semantics.

/** Minimal contract a downloadable model source must satisfy. */
export interface DownloadSource {
  readonly totalBytes: number
  readonly presentBytes: number
  ensure(): Promise<{ ok: true } | { ok: false; error: string }>
  onProgress(handler: (progress: { receivedBytes: number; fileName: string }) => void): () => void
  cancel(): void
}

/** Aggregate progress emitted to the UI during a run. */
export interface DownloadRunProgress {
  receivedBytes: number
  totalBytes: number
  fileName: string
}

/** Terminal outcome of a download run. */
export type DownloadRunResult =
  | { outcome: 'success' }
  | { outcome: 'error'; error: string }
  | { outcome: 'cancelled' }

/** Opaque handle returned to the caller for cancellation. */
export interface DownloadRunHandle {
  cancel(): void
}

/** Default maximum parallel downloads. */
export const MAX_DOWNLOAD_CONCURRENCY = 2

/** Per-source tracking during a run. */
interface SourceSlot {
  readonly totalBytes: number
  received: number
  unsubscribe: (() => void) | null
  cancelDownload: (() => void) | null
}

/**
 * Start a bounded-concurrency download run for the given sources.
 *
 * Guarantees:
 * - At most `maxConcurrency` downloads are in-flight simultaneously.
 * - Progress is clamped per-source to [0, totalBytes] and aggregate is monotonic.
 * - On first failure the result resolves immediately with `error`; active peers
 *   are cancelled and their listeners disposed synchronously — the run does NOT
 *   wait for cancelled peers to settle.
 * - On cancel via the handle, all active listeners and downloads are disposed
 *   synchronously and the result resolves with `cancelled`.
 * - Late progress or settlement from abandoned peers is ignored (identity-scoped).
 */
export function startDownloadRun(
  sources: ReadonlyArray<DownloadSource>,
  onProgress: (progress: DownloadRunProgress) => void,
  maxConcurrency: number = MAX_DOWNLOAD_CONCURRENCY
): { handle: DownloadRunHandle; done: Promise<DownloadRunResult> } {
  const runId = Symbol('download-run')
  let activeRunId: symbol | typeof undefined = runId
  let settled = false

  const totalBytes = Math.max(1, sources.reduce((sum, s) => sum + Math.max(0, s.totalBytes), 0))

  const slots: SourceSlot[] = sources.map((s) => ({
    totalBytes: Math.max(0, s.totalBytes),
    // Seed clamped to [0, totalBytes]
    received: Math.max(0, Math.min(s.presentBytes, Math.max(0, s.totalBytes))),
    unsubscribe: null,
    cancelDownload: null
  }))

  let latestFileName = ''

  // Deferred result — resolved as soon as the outcome is determined
  let resolveDone!: (result: DownloadRunResult) => void
  const done = new Promise<DownloadRunResult>((resolve) => { resolveDone = resolve })

  function isActive(): boolean {
    return activeRunId === runId && !settled
  }

  function emitProgress(): void {
    if (!isActive()) return
    const aggregateReceived = Math.min(
      totalBytes,
      slots.reduce((sum, s) => sum + s.received, 0)
    )
    onProgress({ receivedBytes: aggregateReceived, totalBytes, fileName: latestFileName })
  }

  function disposeAll(): void {
    for (const slot of slots) {
      slot.unsubscribe?.()
      slot.unsubscribe = null
      slot.cancelDownload?.()
      slot.cancelDownload = null
    }
  }

  function settleWith(result: DownloadRunResult): void {
    if (settled) return
    settled = true
    activeRunId = undefined
    disposeAll()
    resolveDone(result)
  }

  const handle: DownloadRunHandle = {
    cancel(): void {
      if (!isActive()) return
      settleWith({ outcome: 'cancelled' })
    }
  }

  // Queue of slot indices to process
  const queue: number[] = slots.map((_, i) => i)

  async function runSlot(index: number): Promise<void> {
    if (!isActive()) return
    const slot = slots[index]
    const source = sources[index]
    if (!slot || !source) return

    const unsubscribe = source.onProgress((p) => {
      if (!isActive()) return
      const clamped = Math.max(0, Math.min(slot.totalBytes, p.receivedBytes))
      if (clamped <= slot.received) return
      slot.received = clamped
      latestFileName = p.fileName
      emitProgress()
    })
    slot.unsubscribe = unsubscribe
    slot.cancelDownload = () => source.cancel()

    let result: { ok: true } | { ok: false; error: string }
    try {
      result = await source.ensure()
    } catch (err) {
      if (!isActive()) return
      const msg = err instanceof Error ? err.message : String(err)
      settleWith({ outcome: 'error', error: msg })
      return
    }

    // Clean up this slot's listener regardless of outcome
    slot.unsubscribe?.()
    slot.unsubscribe = null
    slot.cancelDownload = null

    if (!isActive()) return

    if (!result.ok) {
      settleWith({ outcome: 'error', error: result.error })
      return
    }

    // Success: force to total (last progress event may not have reached 100%)
    slot.received = slot.totalBytes
    emitProgress()
  }

  async function worker(): Promise<void> {
    while (isActive()) {
      const index = queue.shift()
      if (index === undefined) break
      await runSlot(index)
    }
  }

  // Launch workers; when all that will ever start have finished, check for overall success
  const workerCount = Math.min(maxConcurrency, slots.length)
  const workers = Array.from({ length: workerCount }, () => worker())

  // Background: detect all-success (only if not already settled by error/cancel)
  void Promise.all(workers).then(() => {
    if (!isActive()) return
    settleWith({ outcome: 'success' })
  })

  return { handle, done }
}
