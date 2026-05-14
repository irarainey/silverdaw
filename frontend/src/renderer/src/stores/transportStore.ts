// Transport state — mirrors the backend's playhead and play/pause status.
//
// Updated by `bridgeService` on every `PLAYHEAD_UPDATE` message from the
// JUCE backend; mutated locally as well so the UI feels instant before the
// backend's first acknowledgement arrives.

import { defineStore } from 'pinia'

interface TransportState {
  isPlaying: boolean
  /** Current playhead position in ms (master clock). */
  positionMs: number
  /** Project tempo (display-only for now). */
  bpm: number
  /** Whether the backend bridge socket is currently connected. */
  connected: boolean
}

export const useTransportStore = defineStore('transport', {
  state: (): TransportState => ({
    isPlaying: false,
    positionMs: 0,
    bpm: 100,
    connected: false
  }),

  actions: {
    setPlaybackState(isPlaying: boolean, positionMs?: number): void {
      this.isPlaying = isPlaying
      if (typeof positionMs === 'number') this.positionMs = positionMs
    },
    setPosition(positionMs: number): void {
      this.positionMs = positionMs
    },
    setBpm(bpm: number): void {
      // Clamp to a musically sane range. The timeline grid + snap unit
      // both derive from this, so a 0 or negative value would divide by
      // zero in `MS_PER_SUB_BEAT`.
      this.bpm = Math.min(300, Math.max(20, Math.round(bpm * 10) / 10))
    },
    setConnected(connected: boolean): void {
      this.connected = connected
      if (!connected) this.isPlaying = false
    }
  }
})
