import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '@/lib/bridgeService'
import {
  useBrakeSettingsStore,
  BRAKE_DURATION_SECONDS,
  BRAKE_CURVE_POWER
} from '@/stores/brakeSettingsStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const sendMock = vi.mocked(send)
const setBrakeSettings = vi.fn()
const getBrakeSettings = vi.fn(async () => ({ duration: 'long', curve: 'steep' }) as const)

beforeEach(() => {
  setActivePinia(createPinia())
  sendMock.mockClear()
  setBrakeSettings.mockClear()
  getBrakeSettings.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    silverdaw: { setBrakeSettings, getBrakeSettings }
  }
})

describe('brakeSettingsStore', () => {
  it('defaults to the last-tested medium/curved settings', () => {
    const store = useBrakeSettingsStore()
    expect(store.duration).toBe('medium')
    expect(store.curve).toBe('curved')
    expect(store.seconds).toBe(BRAKE_DURATION_SECONDS.medium)
    expect(store.curvePower).toBe(BRAKE_CURVE_POWER.curved)
  })

  it('resolves presets to numeric seconds + curve power', () => {
    const store = useBrakeSettingsStore()
    store.setBrakeSettings('short', 'linear')
    expect(store.seconds).toBe(0.4)
    expect(store.curvePower).toBe(1)
  })

  it('persists and pushes resolved values to the backend on change', () => {
    const store = useBrakeSettingsStore()
    store.setBrakeSettings('long', 'steep')
    expect(setBrakeSettings).toHaveBeenCalledWith({ duration: 'long', curve: 'steep' })
    expect(sendMock).toHaveBeenCalledWith('BRAKE_SETTINGS_SET', { seconds: 0.9, curve: 3 })
  })

  it('re-hydrates from prefs and re-sends to the backend on connect', async () => {
    const store = useBrakeSettingsStore()
    await store.applyBrakeSettingsOnReady()
    expect(getBrakeSettings).toHaveBeenCalled()
    expect(store.duration).toBe('long')
    expect(store.curve).toBe('steep')
    expect(sendMock).toHaveBeenCalledWith('BRAKE_SETTINGS_SET', { seconds: 0.9, curve: 3 })
  })
})
