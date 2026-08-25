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

  describe('PLAYHEAD_UPDATE playback reconciliation', () => {
    it('adopts the engine play state when the UI has been left behind', () => {
      const transport = useTransportStore()
      // A socket blip clears the optimistic flag while the audio thread plays on.
      transport.setPlaybackState(true)
      transport.setConnected(false)
      expect(transport.isPlaying).toBe(false)

      vi.advanceTimersByTime(1000)
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 4200, isPlaying: true })

      expect(transport.isPlaying).toBe(true)
      expect(transport.positionMs).toBe(4200)
    })

    it('adopts a stopped engine when the UI still shows playing', () => {
      const transport = useTransportStore()
      transport.setPlaybackState(true)

      vi.advanceTimersByTime(3000)
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 0, isPlaying: false })

      expect(transport.isPlaying).toBe(false)
    })

    it('lets a fresh local intent outrank an in-flight update', () => {
      const transport = useTransportStore()
      transport.setPlaybackState(true)

      // The engine has not acted on the play command yet.
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 0, isPlaying: false })

      expect(transport.isPlaying).toBe(true)
    })

    // A pause is protected while it could still be in flight; if the engine is *still*
    // reporting playback long after, it genuinely did not pause and the UI must say so
    // rather than sit on an intent that never landed.
    it('holds a pause while it may be in flight, then believes a still-playing engine', () => {
      const transport = useTransportStore()
      transport.setPlaybackState(true)
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 100, isPlaying: true })

      transport.setPlaybackState(false)
      vi.advanceTimersByTime(200)
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 200, isPlaying: true })
      expect(transport.isPlaying).toBe(false)

      vi.advanceTimersByTime(3000)
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 300, isPlaying: true })
      expect(transport.isPlaying).toBe(true)
    })

    // Once the engine confirms an intent, that intent stops shielding the UI — otherwise a
    // later genuine divergence would be ignored for the rest of the window.
    it('stops shielding an intent the engine has already confirmed', () => {
      const transport = useTransportStore()
      transport.setPlaybackState(true)
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 100, isPlaying: true })

      // Reaching the end of the project stops the engine without the UI asking.
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 500, isPlaying: false })

      expect(transport.isPlaying).toBe(false)
    })

    it('keeps the transport armed while a MIDI platter hold pauses the engine', () => {
      const transport = useTransportStore()
      transport.setPlaybackState(true)
      transport.beginMidiPlaybackHold('deck:1')

      vi.advanceTimersByTime(3000)
      transportBridgeHandlers.PLAYHEAD_UPDATE({ positionMs: 1000, isPlaying: false })

      expect(transport.isPlaying).toBe(true)
    })
  })
})
