// Regression coverage for the stem-preference IPC handler. A prior guard only
// compared useGpu/quality before persisting, so toggling a cleanup flag on its
// own (the renderer saves cleanup toggles in their own setStemPrefs call) was
// silently dropped — stems were always separated with enhancement OFF.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (evt: unknown, arg: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'silverdaw' },
  dialog: {},
  ipcMain: {
    handle: (channel: string, fn: (evt: unknown, arg: unknown) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (evt: unknown, arg: unknown) => unknown) => handlers.set(channel, fn)
  }
}))

import { registerPreferencesHandlers } from '@main/ipc/preferencesHandlers'
import { buildDefaultPrefs, type Preferences } from '@main/preferences'

describe('preferences IPC: setStems', () => {
  let store: Preferences
  let flush: ReturnType<typeof vi.fn>

  beforeEach(() => {
    handlers.clear()
    store = buildDefaultPrefs()
    flush = vi.fn()
    registerPreferencesHandlers({
      getMainWindow: () => null,
      getStartupLoggingEnabled: () => false,
      getStartupDevToolsEnabled: () => false,
      prefs: {
        get: () => store,
        flushSaveSync: flush
      } as never
    })
  })

  const setStems = (partial: unknown): void => {
    const fn = handlers.get('prefs:setStems')
    expect(fn).toBeTypeOf('function')
    fn?.({}, partial)
  }

  it('persists a cleanup toggle even when useGpu/quality are unchanged', () => {
    expect(store.stems.enhanceVocals).toBe(false)
    setStems({ enhanceVocals: true, vocalEnhanceStrength: 'strong' })
    expect(store.stems.enhanceVocals).toBe(true)
    expect(store.stems.vocalEnhanceStrength).toBe('strong')
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('persists each stem cleanup flag independently', () => {
    setStems({ enhanceDrums: true })
    setStems({ enhanceBass: true })
    setStems({ enhanceOther: true, otherEnhanceStrength: 'light' })
    expect(store.stems.enhanceDrums).toBe(true)
    expect(store.stems.enhanceBass).toBe(true)
    expect(store.stems.enhanceOther).toBe(true)
    expect(store.stems.otherEnhanceStrength).toBe('light')
    expect(flush).toHaveBeenCalledTimes(3)
  })

  it('does not flush when nothing actually changed', () => {
    setStems({ enhanceVocals: false })
    expect(flush).not.toHaveBeenCalled()
  })

  it('still persists useGpu and quality changes', () => {
    setStems({ useGpu: true, quality: 'best' })
    expect(store.stems.useGpu).toBe(true)
    expect(store.stems.quality).toBe('best')
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
