import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EnsureStemModelResult,
  StemModelDownloadProgress,
  StemModelState
} from '@shared/types'

vi.mock('@/lib/log', () => ({ log: { warn: vi.fn() } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const missing: StemModelState = {
  installed: false,
  presentBytes: 20,
  totalBytes: 100,
  fileCount: 1
}
const installed: StemModelState = {
  installed: true,
  presentBytes: 100,
  totalBytes: 100,
  fileCount: 1
}
let vocalProgress: ((progress: StemModelDownloadProgress) => void) | null = null
const stopVocal = vi.fn()
const stopRhythm = vi.fn()
const api = {
  getVocalPackState: vi.fn(async () => missing),
  getRhythmPackState: vi.fn(async () => missing),
  ensureVocalPack: vi.fn(async (): Promise<EnsureStemModelResult> => {
    api.getVocalPackState.mockResolvedValue(installed)
    return { ok: true }
  }),
  ensureRhythmPack: vi.fn(async (): Promise<EnsureStemModelResult> => {
    api.getRhythmPackState.mockResolvedValue(installed)
    return { ok: true }
  }),
  onVocalPackDownloadProgress: vi.fn((handler: (p: StemModelDownloadProgress) => void) => {
    vocalProgress = handler
    return stopVocal
  }),
  onRhythmPackDownloadProgress: vi.fn(() => stopRhythm),
  cancelVocalPackDownload: vi.fn(),
  cancelRhythmPackDownload: vi.fn()
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  api.getVocalPackState.mockResolvedValue(missing)
  api.getRhythmPackState.mockResolvedValue(missing)
  vocalProgress = null
  vi.stubGlobal('window', { silverdaw: api })
})

afterEach(() => vi.unstubAllGlobals())

describe('quality model downloads', () => {
  it('retains ownership and progress after the Preferences scope is replaced', async () => {
    const pending = deferred<EnsureStemModelResult>()
    api.ensureVocalPack.mockReturnValueOnce(pending.promise)
    const { useStemQualityModels } = await import('@/lib/stems/useStemQualityModels')
    const scope = effectScope()
    const first = scope.run(useStemQualityModels)!
    const download = first.downloadQualityModels()
    await vi.waitFor(() => expect(api.ensureVocalPack).toHaveBeenCalledOnce())
    expect(first.qualityPercent.value).toBe(20)
    vocalProgress?.({
      receivedBytes: 60,
      totalBytes: 100,
      fileName: 'model',
      fileIndex: 0,
      fileCount: 1
    })
    scope.stop()

    const replacementScope = effectScope()
    const replacement = replacementScope.run(useStemQualityModels)!
    expect(replacement.qualityBusy.value).toBe(true)
    expect(replacement.qualityPercent.value).toBe(40)
    await replacement.downloadQualityModels()
    expect(api.ensureVocalPack).toHaveBeenCalledOnce()

    api.getVocalPackState.mockResolvedValue(installed)
    pending.resolve({ ok: true })
    await download
    expect(replacement.qualityInstalled.value).toBe(true)
    expect(replacement.qualityBusy.value).toBe(false)
    expect(replacement.qualityPercent.value).toBe(100)
    expect(stopVocal).toHaveBeenCalledOnce()
    expect(stopRhythm).toHaveBeenCalledOnce()
    replacementScope.stop()
  })

  it('cancels from a replacement view and waits for main to acknowledge before retrying', async () => {
    const pending = deferred<EnsureStemModelResult>()
    api.ensureVocalPack.mockReturnValueOnce(pending.promise)
    const { useStemQualityModels } = await import('@/lib/stems/useStemQualityModels')
    const first = useStemQualityModels()
    const download = first.downloadQualityModels()
    await vi.waitFor(() => expect(api.ensureVocalPack).toHaveBeenCalledOnce())
    const replacement = useStemQualityModels()

    replacement.cancelQualityDownload()
    expect(api.cancelVocalPackDownload).toHaveBeenCalledOnce()
    expect(replacement.qualityBusy.value).toBe(true)
    expect(stopVocal).toHaveBeenCalledOnce()
    pending.resolve({ ok: false, error: 'Cancelled' })
    await download
    expect(api.ensureRhythmPack).not.toHaveBeenCalled()
    expect(replacement.qualityBusy.value).toBe(false)
    expect(replacement.qualityError.value).toBeNull()

    await replacement.downloadQualityModels()
    expect(api.ensureVocalPack).toHaveBeenCalledTimes(2)
    expect(replacement.qualityInstalled.value).toBe(true)
  })

  it('honours cancellation while the initial model-state lookup is pending', async () => {
    const pending = deferred<StemModelState>()
    api.getVocalPackState.mockReturnValueOnce(pending.promise)
    const { useStemQualityModels } = await import('@/lib/stems/useStemQualityModels')
    const models = useStemQualityModels()
    const download = models.downloadQualityModels()
    models.cancelQualityDownload()
    pending.resolve(missing)
    await download

    expect(api.ensureVocalPack).not.toHaveBeenCalled()
    expect(api.ensureRhythmPack).not.toHaveBeenCalled()
    expect(models.qualityBusy.value).toBe(false)
  })

  it('surfaces download errors and allows a successful retry', async () => {
    api.ensureVocalPack.mockRejectedValueOnce(new Error('Offline'))
    const { useStemQualityModels } = await import('@/lib/stems/useStemQualityModels')
    const models = useStemQualityModels()
    await models.downloadQualityModels()
    expect(models.qualityError.value).toBe('Offline')
    expect(models.qualityBusy.value).toBe(false)
    expect(api.ensureRhythmPack).not.toHaveBeenCalled()

    await models.downloadQualityModels()
    expect(models.qualityError.value).toBeNull()
    expect(models.qualityInstalled.value).toBe(true)
  })

  it('shares an active download with other model-source consumers', async () => {
    const pending = deferred<EnsureStemModelResult>()
    api.ensureVocalPack.mockReturnValueOnce(pending.promise)
    const { useStemQualityModels } = await import('@/lib/stems/useStemQualityModels')
    const { MODEL_SOURCES } = await import('@/lib/stems/stemModelSources')
    const download = useStemQualityModels().downloadQualityModels()
    await vi.waitFor(() => expect(api.ensureVocalPack).toHaveBeenCalledOnce())
    const attached = MODEL_SOURCES.vocalPack.ensure()
    expect(api.ensureVocalPack).toHaveBeenCalledOnce()
    api.getVocalPackState.mockResolvedValue(installed)
    pending.resolve({ ok: true })
    await Promise.all([download, attached])
    expect(api.ensureVocalPack).toHaveBeenCalledOnce()
  })
})
