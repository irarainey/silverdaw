import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreferencesForm } from './usePreferencesForm'
import { useUiStore } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import type { UniqueDevice } from '@/lib/audio/audioOutputPicker'

const devicesRef = vi.hoisted(() => ({ value: [] as UniqueDevice[] }))

vi.mock('@/lib/audio/audioOutputPicker', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/audio/audioOutputPicker')>()
  return { ...actual, useUniqueAudioDevices: () => computed(() => devicesRef.value) }
})

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const DEFAULTS = {
  debug: { loggingEnabled: false, devToolsEnabled: false, logDirectory: '' },
  qol: { toasts: { enabled: true }, paths: { defaultProjectDir: 'P:\\', defaultClipDir: 'C:\\' } },
  autosave: { enabled: true, intervalSeconds: 30 },
  audio: { typeName: null as string | null, deviceName: null as string | null }
}

function stubSilverdaw(): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    silverdaw: {
      getDebugPreferences: vi.fn(async () => ({ ...DEFAULTS.debug })),
      getQolPrefs: vi.fn(async () => structuredClone(DEFAULTS.qol)),
      getAutosaveConfig: vi.fn(async () => ({ ...DEFAULTS.autosave })),
      getAudioOutput: vi.fn(async () => ({ ...DEFAULTS.audio })),
      setQolPrefs: vi.fn(),
      setDebugPreferences: vi.fn(),
      setAutosaveConfig: vi.fn(),
      chooseDirectory: vi.fn()
    }
  }
}

describe('usePreferencesForm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    devicesRef.value = []
    stubSilverdaw()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pickDevice selects the device and auto-picks its preferred backend', () => {
    const form = usePreferencesForm()
    const device: UniqueDevice = { name: 'Speakers', backends: ['DirectSound', 'Windows Audio'] }
    form.pickDevice(device)
    expect(form.audioOutputDeviceName.value).toBe('Speakers')
    // 'Windows Audio' outranks 'DirectSound' in BACKEND_PREFERENCE.
    expect(form.audioOutputTypeName.value).toBe('Windows Audio')
    expect(form.audioHasSelection.value).toBe(true)
  })

  it('pickSystemDefault clears the pending audio selection', () => {
    const form = usePreferencesForm()
    form.pickDevice({ name: 'Speakers', backends: ['Windows Audio'] })
    form.pickSystemDefault()
    expect(form.audioOutputDeviceName.value).toBeNull()
    expect(form.audioOutputTypeName.value).toBeNull()
    expect(form.audioHasSelection.value).toBe(false)
  })

  it('hasChanges is false right after load and true once a working ref changes', async () => {
    const form = usePreferencesForm()
    await form.loadCurrent()
    expect(form.hasChanges.value).toBe(false)
    form.toastsEnabled.value = false
    expect(form.hasChanges.value).toBe(true)
  })

  it('save dispatches only the changed deltas', async () => {
    const ui = useUiStore()
    const setFollow = vi.spyOn(ui, 'setFollowPlayback')
    const form = usePreferencesForm()
    await form.loadCurrent()

    form.loggingEnabled.value = true
    form.save()

    expect(window.silverdaw.setDebugPreferences).toHaveBeenCalledWith({
      loggingEnabled: true,
      devToolsEnabled: false,
      logDirectory: ''
    })
    // Untouched preferences must not be pushed.
    expect(window.silverdaw.setQolPrefs).not.toHaveBeenCalled()
    expect(setFollow).not.toHaveBeenCalled()
  })

  it('save routes a pending audio selection through the device store', async () => {
    const audioDevices = useAudioDeviceStore()
    const selectDevice = vi.spyOn(audioDevices, 'selectDevice').mockImplementation(() => {})
    const form = usePreferencesForm()
    await form.loadCurrent()

    form.pickDevice({ name: 'Speakers', backends: ['Windows Audio'] })
    form.save()

    expect(selectDevice).toHaveBeenCalledWith('Windows Audio', 'Speakers')
  })

  it('save is a no-op against the backend when nothing changed', async () => {
    const form = usePreferencesForm()
    await form.loadCurrent()
    form.save()
    expect(window.silverdaw.setQolPrefs).not.toHaveBeenCalled()
    expect(window.silverdaw.setDebugPreferences).not.toHaveBeenCalled()
    expect(window.silverdaw.setAutosaveConfig).not.toHaveBeenCalled()
  })
})
