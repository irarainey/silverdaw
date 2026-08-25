// Transport state mirrors backend playhead and playback status.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'
import { clampBpm } from '@/lib/musicTime'

interface TransportState {
  isPlaying: boolean
  /** Enabled MIDI platter touches, keyed by device and physical deck. */
  midiPlaybackHoldSources: string[]
  /** Master-clock playhead position in ms. */
  positionMs: number
  bpm: number
  /**
   * True once the project tempo is established (backend-owned `bpmSeeded`).
   *
   * Mirrored, never inferred: drop auto-warp needs to know the tempo is a real
   * target rather than the transient default, and "does the timeline already hold
   * a clip?" is not the same question — a project can load with an established
   * tempo and an empty timeline.
   */
  bpmSeeded: boolean
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
  /**
   * Audio-device readiness, from the backend `ENGINE_AUDIO_STATUS` broadcast. The device now
   * opens on a worker thread after the bridge is serving, so the project/UI can be interactive
   * while this is still `'starting'`; transport stays gated until `'ready'`.
   */
  audioState: 'starting' | 'ready' | 'failed' | 'no_device'
  hasBeenReady: boolean
  /**
   * `performance.now()` of the last local play/pause intent the engine has not yet
   * confirmed, or null when there is none outstanding. `PLAYHEAD_UPDATE` is reconciled
   * against it so an update still describing the pre-click state cannot undo the click.
   */
  playIntentAt: number | null
}

/**
 * How long an unconfirmed local play/pause intent outranks the engine's reported state.
 * The intent is normally cleared the moment the engine agrees, so this is only the cap for
 * a command that never lands — long enough to cover a badly delayed round trip, short
 * enough that a UI left out of step self-corrects before the user notices.
 */
const PLAY_INTENT_SETTLE_MS = 2000

export const useTransportStore = defineStore('transport', {
  state: (): TransportState => ({
    isPlaying: false,
    midiPlaybackHoldSources: [],
    positionMs: 0,
    bpm: 100,
    bpmSeeded: false,
    connected: false,
    bridgeReady: false,
    handshakeReady: false,
    bridgeFailureMessage: null,
    engineRecovery: 'ok',
    audioState: 'starting',
    hasBeenReady: false,
    playIntentAt: null
  }),

  getters: {
    midiPlaybackHoldActive: (state): boolean => state.midiPlaybackHoldSources.length > 0,
    isPlaybackHeld(): boolean {
      return this.isPlaying && this.midiPlaybackHoldActive
    }
  },

  actions: {
    setPlaybackState(isPlaying: boolean, positionMs?: number): void {
      if (this.isPlaying !== isPlaying) {
        log.info('transport', `playback state -> ${isPlaying ? 'playing' : 'paused'}` +
          (typeof positionMs === 'number' ? ` @ ${positionMs.toFixed(0)}ms` : ''))
      }
      this.isPlaying = isPlaying
      this.playIntentAt = performance.now()
      if (typeof positionMs === 'number') this.positionMs = positionMs
    },

    /**
     * Adopt "stopped" after the backend replaced the project or rebuilt the graph for
     * undo/redo, both of which stop the engine.
     *
     * This is authoritative state, not local intent, so it clears `playIntentAt` rather
     * than stamping it. Stamping made the next `PLAYHEAD_UPDATE` wait out the settle
     * window before it could correct anything, which is why the transport sat wrong for
     * two seconds after a snapshot instead of being reconciled at once.
     */
    resetPlaybackForProjectChange(): void {
      if (this.isPlaying) {
        log.info('transport', 'playback state -> paused (project replaced)')
      }
      this.isPlaying = false
      this.playIntentAt = null
      this.clearMidiPlaybackHolds()
    },

    /**
     * Adopt the backend's playback state from `PLAYHEAD_UPDATE`.
     *
     * Local intent is optimistic, so it can be left stranded: a socket blip clears
     * `isPlaying` while the audio thread plays on, and a command dropped because the
     * socket was not open sets it without the engine ever agreeing. Nothing used to
     * put those back in step, so the UI could sit at "stopped" over audible playback
     * until the user clicked again. The engine already reports the truth 60 times a
     * second — this takes it, except in the two cases where the UI is knowingly ahead
     * of the engine: inside the settle window after a click, and while a MIDI platter
     * hold pauses the engine but keeps the transport armed.
     */
    reconcilePlaybackState(isPlaying: boolean): void {
      if (this.isPlaying === isPlaying) {
        // The engine agrees, so there is no longer an intent in flight to protect. Clearing
        // it here is what stops a slow round trip from being adopted as a disagreement once
        // the window lapses, which would show as the transport flicking back and forth.
        this.playIntentAt = null
        return
      }
      if (this.midiPlaybackHoldActive) return
      if (
        this.playIntentAt !== null &&
        performance.now() - this.playIntentAt < PLAY_INTENT_SETTLE_MS
      ) {
        return
      }
      log.info('transport', `playback state reconciled -> ${isPlaying ? 'playing' : 'paused'}`)
      this.isPlaying = isPlaying
      this.playIntentAt = null
    },
    setPosition(positionMs: number): void {
      this.positionMs = positionMs
    },
    beginMidiPlaybackHold(source: string): boolean {
      if (this.midiPlaybackHoldSources.includes(source)) return false
      const first = this.midiPlaybackHoldSources.length === 0
      this.midiPlaybackHoldSources = [...this.midiPlaybackHoldSources, source]
      return first
    },
    endMidiPlaybackHold(source: string): boolean {
      const previousLength = this.midiPlaybackHoldSources.length
      this.midiPlaybackHoldSources =
        this.midiPlaybackHoldSources.filter((activeSource) => activeSource !== source)
      return previousLength > 0 && this.midiPlaybackHoldSources.length === 0
    },
    endMidiPlaybackHoldsForDevice(deviceIdentifier: string): boolean {
      const prefix = `${deviceIdentifier}:`
      const previousLength = this.midiPlaybackHoldSources.length
      this.midiPlaybackHoldSources =
        this.midiPlaybackHoldSources.filter((source) => !source.startsWith(prefix))
      return previousLength > 0 && this.midiPlaybackHoldSources.length === 0
    },
    clearMidiPlaybackHolds(): void {
      this.midiPlaybackHoldSources = []
    },
    setBpm(bpm: number): void {
      // Clamp away invalid grid math, but keep full precision to avoid timeline drift.
      this.bpm = clampBpm(bpm)
    },
    setBpmSeeded(seeded: boolean): void {
      this.bpmSeeded = seeded
    },
    setConnected(connected: boolean): void {
      this.connected = connected
      if (!connected) {
        this.isPlaying = false
        // The drop is not a play/pause intent: leaving one pending would block the
        // reconcile that puts the UI back in step once the socket returns.
        this.playIntentAt = null
        this.clearMidiPlaybackHolds()
        this.bridgeReady = false
        this.handshakeReady = false
        // A fresh connection re-runs the audio-open handshake.
        this.audioState = 'starting'
      }
    },
    /** Audio-device readiness from the backend `ENGINE_AUDIO_STATUS` broadcast. */
    setAudioState(state: TransportState['audioState']): void {
      if (
        state === 'starting' &&
        (this.audioState === 'no_device' || this.audioState === 'failed')
      ) {
        log.warn('transport', `ignored stale audioState -> ${state}`)
        return
      }
      if (this.audioState !== state) {
        log.info('transport', `audioState -> ${state}`)
      }
      this.audioState = state
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
