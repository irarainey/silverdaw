import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '@/lib/bridgeService'
import { useScratchRealismSettingsStore } from '@/stores/scratchRealismSettingsStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const sendMock = vi.mocked(send)
const setScratchRealismSettings = vi.fn()
const getScratchRealismSettings = vi.fn(async () => ({ level: 'high' }) as const)

beforeEach(() => {
  setActivePinia(createPinia())
  sendMock.mockClear()
  setScratchRealismSettings.mockClear()
  getScratchRealismSettings.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    silverdaw: { setScratchRealismSettings, getScratchRealismSettings }
  }
})

describe('scratchRealismSettingsStore', () => {
  it('defaults to medium realism', () => {
    expect(useScratchRealismSettingsStore().level).toBe('medium')
  })

  it('persists and applies the selected level immediately', () => {
    const store = useScratchRealismSettingsStore()
    store.setScratchRealismLevel('off')

    expect(setScratchRealismSettings).toHaveBeenCalledWith({ level: 'off' })
    expect(sendMock).toHaveBeenCalledWith('SCRATCH_REALISM_SET', { level: 'off' })
  })

  it('re-hydrates and re-applies the preference on backend ready', async () => {
    const store = useScratchRealismSettingsStore()
    await store.applyScratchRealismOnReady()

    expect(getScratchRealismSettings).toHaveBeenCalled()
    expect(store.level).toBe('high')
    expect(sendMock).toHaveBeenCalledWith('SCRATCH_REALISM_SET', { level: 'high' })
  })
})
