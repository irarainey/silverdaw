import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { transportBridgeHandlers } from '@/lib/bridge/handlers/transportHandlers'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useTransportStore } from '@/stores/transportStore'

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

describe('transport bridge handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a terminal no-device status when a stale starting snapshot arrives', () => {
    const transport = useTransportStore()
    const notifications = useNotificationsStore()

    transportBridgeHandlers.ENGINE_AUDIO_STATUS({ state: 'no_device' })
    transportBridgeHandlers.ENGINE_AUDIO_STATUS({ state: 'starting' })

    expect(transport.audioState).toBe('no_device')
    expect(notifications.items.map((item) => item.message)).toEqual([
      'No audio output could be opened. Check your device connection or choose another output.'
    ])
  })
})
