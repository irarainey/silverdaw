import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '@/lib/bridgeService'
import {
  useBackspinSettingsStore,
  BACKSPIN_DURATION_SECONDS,
  BACKSPIN_INTENSITY_SPEED,
  BACKSPIN_CURVE_POWER
} from '@/stores/backspinSettingsStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const sendMock = vi.mocked(send)
const setBackspinSettings = vi.fn()
const getBackspinSettings = vi.fn(async () => ({ duration: 'long', intensity: 'wild' }) as const)

beforeEach(() => {
  setActivePinia(createPinia())
  sendMock.mockClear()
  setBackspinSettings.mockClear()
  getBackspinSettings.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    silverdaw: { setBackspinSettings, getBackspinSettings }
  }
})

describe('backspinSettingsStore', () => {
  it('defaults to long duration + medium intensity', () => {
    const store = useBackspinSettingsStore()
    expect(store.duration).toBe('long')
    expect(store.intensity).toBe('medium')
    expect(store.seconds).toBe(BACKSPIN_DURATION_SECONDS.long)
    expect(store.speed).toBe(BACKSPIN_INTENSITY_SPEED.medium)
    expect(store.curvePower).toBe(BACKSPIN_CURVE_POWER)
  })

  it('resolves presets to numeric seconds + speed', () => {
    const store = useBackspinSettingsStore()
    store.setBackspinSettings('short', 'gentle')
    expect(store.seconds).toBe(0.4)
    expect(store.speed).toBe(4)
  })

  it('persists and pushes resolved values to the backend on change', () => {
    const store = useBackspinSettingsStore()
    store.setBackspinSettings('long', 'wild')
    expect(setBackspinSettings).toHaveBeenCalledWith({ duration: 'long', intensity: 'wild' })
    expect(sendMock).toHaveBeenCalledWith('BACKSPIN_SETTINGS_SET', { seconds: 0.9, speed: 8, curve: 3 })
  })

  it('re-hydrates from prefs and re-sends to the backend on connect', async () => {
    const store = useBackspinSettingsStore()
    await store.applyBackspinSettingsOnReady()
    expect(getBackspinSettings).toHaveBeenCalled()
    expect(store.duration).toBe('long')
    expect(store.intensity).toBe('wild')
    expect(sendMock).toHaveBeenCalledWith('BACKSPIN_SETTINGS_SET', { seconds: 0.9, speed: 8, curve: 3 })
  })
})
