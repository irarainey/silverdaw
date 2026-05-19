// Transport state — mirrors the backend's playhead and play/pause status.
//
// Updated by `bridgeService` on every `PLAYHEAD_UPDATE` message from the
// JUCE backend; mutated locally as well so the UI feels instant before the
// backend's first acknowledgement arrives.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'

interface TransportState {
  isPlaying: boolean
  /** Current playhead position in ms (master clock). */
  positionMs: number
  /** Project tempo (display-only for now). */
  bpm: number
  /** Whether the backend bridge socket is currently connected. */
  connected: boolean
  /**
   * True only after both the WebSocket is OPEN and the backend has
   * delivered its initial `PROJECT_STATE` snapshot. This is the gate
   * the UI uses to block input — until it's true the renderer doesn't
   * know the authoritative project state and any user action would
   * race the reconcile pass.
   */
  bridgeReady: boolean
  /**
   * Set when the initial bridge connection has timed out (or otherwise
   * failed terminally). When non-null the BridgeReadyOverlay swaps from
   * its spinner state to an error message with a "Quit" button. Once
   * set this stays set — there's no useful recovery path mid-session
   * because the backend either never started or is responding with an
   * incompatible protocol; quitting and relaunching is the right move.
   */
  bridgeFailureMessage: string | null
}

export const useTransportStore = defineStore('transport', {
  state: (): TransportState => ({
    isPlaying: false,
    positionMs: 0,
    bpm: 100,
    connected: false,
    bridgeReady: false,
    bridgeFailureMessage: null
  }),

  actions: {
    setPlaybackState(isPlaying: boolean, positionMs?: number): void {
      if (this.isPlaying !== isPlaying) {
        log.info('transport', `playback state -> ${isPlaying ? 'playing' : 'paused'}` +
          (typeof positionMs === 'number' ? ` @ ${positionMs.toFixed(0)}ms` : ''))
      }
      this.isPlaying = isPlaying
      if (typeof positionMs === 'number') this.positionMs = positionMs
    },
    setPosition(positionMs: number): void {
      this.positionMs = positionMs
    },
    setBpm(bpm: number): void {
      // Clamp to a musically sane range. The timeline grid + snap
      // unit both derive from this, so a 0 or negative value would
      // divide by zero in `MS_PER_SUB_BEAT`. We store the value at
      // full precision — the UI displays 2 d.p. via `toFixed(2)`,
      // but the grid math benefits from the extra digits when the
      // BPM was seeded from a library item with a fractional
      // tempo (e.g. 124.378). Rounding to 2 d.p. before storing
      // introduced cumulative drift across long timelines.
      this.bpm = Math.min(300, Math.max(20, bpm))
    },
    setConnected(connected: boolean): void {
      this.connected = connected
      if (!connected) {
        this.isPlaying = false
        // Drop the ready flag on disconnect so the UI re-blocks until
        // we get a fresh PROJECT_STATE on reconnect.
        this.bridgeReady = false
      }
    },
    /** Called by the bridge service when PROJECT_STATE arrives. */
    setBridgeReady(ready: boolean): void {
      this.bridgeReady = ready
    },
    /** Set a terminal bridge-startup failure message (shown in the overlay). */
    setBridgeFailure(message: string | null): void {
      this.bridgeFailureMessage = message
    }
  }
})
