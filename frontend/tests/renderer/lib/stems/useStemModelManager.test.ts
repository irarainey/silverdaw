import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStemModelManager } from '@/lib/stems/useStemModelManager'

function stubSilverdaw(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    silverdaw: {
      getStemGpuStatus: vi.fn(async () => ({ available: true, name: 'Test GPU' })),
      getStemModelInfo: vi.fn(async () => ({
        directory: 'C:/models/htdemucs-ft',
        located: false,
        installed: false
      })),
      ensureStemModel: vi.fn(async () => ({ ok: true })),
      cancelStemModelDownload: vi.fn(),
      onStemModelDownloadProgress: vi.fn(() => () => {}),
      locateStemModel: vi.fn(async () => ({ ok: true, directory: 'D:/models' })),
      chooseDirectory: vi.fn(async () => 'D:/models'),
      ...overrides
    }
  }
}

describe('useStemModelManager', () => {
  beforeEach(() => stubSilverdaw())
  afterEach(() => vi.unstubAllGlobals())

  it('refresh loads GPU status and model info', async () => {
    const mgr = useStemModelManager()
    await mgr.refresh()
    expect(mgr.gpu.value).toEqual({ available: true, name: 'Test GPU' })
    expect(mgr.modelInfo.value?.directory).toBe('C:/models/htdemucs-ft')
    expect(mgr.installed.value).toBe(false)
  })

  it('download runs ensureStemModel and refreshes afterwards', async () => {
    stubSilverdaw({
      getStemModelInfo: vi.fn(async () => ({ directory: 'C:/m', located: false, installed: true }))
    })
    const mgr = useStemModelManager()
    await mgr.download()
    expect(window.silverdaw.ensureStemModel).toHaveBeenCalledOnce()
    expect(mgr.busy.value).toBe(false)
    expect(mgr.installed.value).toBe(true)
  })

  it('download surfaces an error result', async () => {
    stubSilverdaw({ ensureStemModel: vi.fn(async () => ({ ok: false, error: 'boom' })) })
    const mgr = useStemModelManager()
    await mgr.download()
    expect(mgr.error.value).toBe('boom')
  })

  it('locate validates a chosen directory and refreshes', async () => {
    const mgr = useStemModelManager()
    await mgr.locate()
    expect(window.silverdaw.chooseDirectory).toHaveBeenCalledOnce()
    expect(window.silverdaw.locateStemModel).toHaveBeenCalledWith('D:/models')
    expect(window.silverdaw.getStemModelInfo).toHaveBeenCalled()
  })

  it('locate is a no-op when the picker is cancelled', async () => {
    stubSilverdaw({ chooseDirectory: vi.fn(async () => null) })
    const mgr = useStemModelManager()
    await mgr.locate()
    expect(window.silverdaw.locateStemModel).not.toHaveBeenCalled()
  })
})
