// Transport state mirrors backend playhead and playback status.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'

interface TransportState {
  isPlaying: boolean
  /** Master-clock playhead position in ms. */
  positionMs: number
  bpm: number
  connected: boolean
  /** True after socket open and initial `PROJECT_STATE` reconcile. */
  bridgeReady: boolean
  /**
   * True after the WebSocket handshake (`READY`) — the backend is reachable. This precedes
   * `bridgeReady`: the backend now opens the audio device AFTER the bridge is serving, so the
   * UI can appear on the handshake without waiting for a slow cold-start device open.
   */
  handshakeReady: boolean
  /** Terminal startup bridge failure shown by StartupScreen. */
  bridgeFailureMessage: string | null
  /** Mid-session engine recovery phase; cold-start failures use `bridgeFailureMessage`. */
  engineRecovery: 'ok' | 'recovering' | 'restoring' | 'unavailable'
  hasBeenReady: boolean
}

export const useTransportStore = defineStore('transport', {
  state: (): TransportState => ({
    isPlaying: false,
    positionMs: 0,
    bpm: 100,
    connected: false,
    bridgeReady: false,
    handshakeReady: false,
    bridgeFailureMessage: null,
    engineRecovery: 'ok',
    hasBeenReady: false
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
      // Clamp away invalid grid math, but keep full precision to avoid timeline drift.
      this.bpm = Math.min(300, Math.max(20, bpm))
    },
    setConnected(connected: boolean): void {
      this.connected = connected
      if (!connected) {
        this.isPlaying = false
        this.bridgeReady = false
        this.handshakeReady = false
      }
    },
    /** WebSocket handshake (`READY`) received — backend reachable, before PROJECT_STATE. */
    setHandshakeReady(ready: boolean): void {
      this.handshakeReady = ready
    },
    setBridgeReady(ready: boolean): void {
      this.bridgeReady = ready
      if (ready) {
        this.hasBeenReady = true
        // PROJECT_STATE implies the handshake already completed.
        this.handshakeReady = true
      }
    },
    setBridgeFailure(message: string | null): void {
      this.bridgeFailureMessage = message
    },
    setEngineRecovery(phase: TransportState['engineRecovery']): void {
      if (this.engineRecovery !== phase) {
        log.info('transport', `engineRecovery -> ${phase}`)
      }
      this.engineRecovery = phase
    }
  }
})
