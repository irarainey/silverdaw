// Track domain actions for the project store. Spread into the store's `actions`
// so call sites stay `useProjectStore().addTrack(...)` etc. `this` is the store
// instance; ThisType narrows it to ProjectState + the sibling track actions used.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type { ProjectState, Track } from './projectTypes'
import { DEFAULT_TRACK_LENGTH_MS, MAX_TRACK_VOLUME, TRACK_PALETTE } from './projectTypes'

type TrackActionsThis = ProjectState & {
  pushAllGains(): void
}

export const trackActions = {
    addTrack(): string {
      // UUIDs stay stable across renderer reloads and save/load cycles.
      const trackId = crypto.randomUUID()
      const track: Track = {
        id: trackId,
        name: `Track ${this.tracks.length + 1}`,
        clipIds: [],
        muted: false,
        soloed: false,
        volume: 1.0,
        colorIndex: this.tracks.length % TRACK_PALETTE.length,
        lengthMs: DEFAULT_TRACK_LENGTH_MS
      }
      this.tracks.push(track)
      // Optimistic; TRACK_ADDED is diagnostic because the renderer already shows it.
      sendBridge('TRACK_ADD', { trackId, name: track.name })
      log.info('project', `addTrack id=${trackId}`)
      return trackId
    },

    /** Update Tone EQ / Filter; localOnly reconciles backend acks without echoing gestures. */
    setTrackTone(
      trackId: string,
      patch: { bassDb?: number; midDb?: number; trebleDb?: number; filter?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clampDb = (v: number): number =>
        Math.max(-15, Math.min(15, Number.isFinite(v) ? v : 0))
      if (patch.bassDb !== undefined) {
        const v = clampDb(patch.bassDb)
        track.toneBassDb = v !== 0 ? v : undefined
      }
      if (patch.midDb !== undefined) {
        const v = clampDb(patch.midDb)
        track.toneMidDb = v !== 0 ? v : undefined
      }
      if (patch.trebleDb !== undefined) {
        const v = clampDb(patch.trebleDb)
        track.toneTrebleDb = v !== 0 ? v : undefined
      }
      if (patch.filter !== undefined) {
        const v = Math.max(-1, Math.min(1, Number.isFinite(patch.filter) ? patch.filter : 0))
        track.toneFilter = v !== 0 ? v : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_TONE', {
          trackId,
          bassDb: patch.bassDb,
          midDb: patch.midDb,
          trebleDb: patch.trebleDb,
          filter: patch.filter,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update sends; undefined patch fields fall back to the current track value. */
    setTrackSends(
      trackId: string,
      patch: { reverbSend?: number; delaySend?: number },
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clampUnit = (v: number): number =>
        Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
      if (patch.reverbSend !== undefined) {
        const v = clampUnit(patch.reverbSend)
        track.reverbSend = v !== 0 ? v : undefined
      }
      if (patch.delaySend !== undefined) {
        const v = clampUnit(patch.delaySend)
        track.delaySend = v !== 0 ? v : undefined
      }
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_SENDS', {
          trackId,
          reverbSend: patch.reverbSend ?? track.reverbSend ?? 0,
          delaySend: patch.delaySend ?? track.delaySend ?? 0,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update pan; localOnly reconciles backend acks without echoing gestures. */
    setTrackPan(
      trackId: string,
      pan: number,
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
      track.pan = clamped !== 0 ? clamped : undefined
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_PAN', {
          trackId,
          pan: clamped,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    /** Update Leveler amount; localOnly reconciles backend acks. */
    setTrackLeveler(
      trackId: string,
      amount: number,
      opts?: { localOnly?: boolean; gestureId?: string; gestureEnd?: boolean }
    ): void {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return
      const clamped = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0))
      track.levelerAmount = clamped !== 0 ? clamped : undefined
      if (!opts?.localOnly) {
        sendBridge('TRACK_SET_LEVELER', {
          trackId,
          amount: clamped,
          gestureId: opts?.gestureId,
          gestureEnd: opts?.gestureEnd
        })
      }
    },

    removeTrack(trackId: string): void {
      const idx = this.tracks.findIndex((t) => t.id === trackId)
      if (idx < 0) return

      const track = this.tracks[idx]
      if (!track) return
      for (const clipId of track.clipIds) {
        delete this.clips[clipId]
        delete this.duplicateTailBySource[clipId]
        for (const [sourceId, tailId] of Object.entries(this.duplicateTailBySource)) {
          if (tailId === clipId) delete this.duplicateTailBySource[sourceId]
        }
        if (this.selectedClipId === clipId) this.selectedClipId = null
      }
      if (this.selectedTrackId === trackId) this.selectedTrackId = null
      this.tracks.splice(idx, 1)

      sendBridge('TRACK_REMOVE', { trackId })

      if (track.soloed) this.pushAllGains()
      log.info('project', `removeTrack id=${trackId}`)
    },

    /** Toggle persisted mute; backend derives effective gain. Mute and solo are
     * mutually exclusive, so engaging mute clears any solo on the same track. */
    toggleMute(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.muted = !t.muted
      log.info('project', `toggleMute id=${trackId} muted=${t.muted}`)
      sendBridge('TRACK_MUTE', { trackId, muted: t.muted })
      if (t.muted && t.soloed) {
        t.soloed = false
        log.info('project', `toggleMute cleared solo id=${trackId}`)
        sendBridge('TRACK_SOLO', { trackId, soloed: false })
      }
    },

    /** Toggle solo; backend re-pushes project-wide effective gain. Mute and solo are
     * mutually exclusive, so engaging solo clears any mute on the same track. */
    toggleSolo(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.soloed = !t.soloed
      log.info('project', `toggleSolo id=${trackId} soloed=${t.soloed}`)
      sendBridge('TRACK_SOLO', { trackId, soloed: t.soloed })
      if (t.soloed && t.muted) {
        t.muted = false
        log.info('project', `toggleSolo cleared mute id=${trackId}`)
        sendBridge('TRACK_MUTE', { trackId, muted: false })
      }
    },

    /** Re-push user volume; backend folds in mute/solo. */
    pushTrackGain(track: Track): void {
      sendBridge('TRACK_GAIN', { trackId: track.id, gain: track.volume })
    },

    /** Re-push all user volumes after reconnect; mute/solo ride PROJECT_STATE. */
    pushAllGains(): void {
      for (const t of this.tracks) {
        sendBridge('TRACK_GAIN', { trackId: t.id, gain: t.volume })
      }
    },

    /** Commit track volume; live drags use setTrackVolumeLocal to avoid bridge flood. */
    setTrackVolume(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
      log.debug('project', `setTrackVolume id=${trackId} volume=${t.volume}`)
      sendBridge('TRACK_GAIN', { trackId, gain: t.volume })
    },

    setTrackVolumeLocal(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
    },

    /** Local-only row resize preview; commit once on pointerup. */
    setTrackHeightLocal(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
    },

    /** Commit row height; PROJECT_STATE ack returns any backend clamp. */
    setTrackHeight(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
      sendBridge('TRACK_SET_HEIGHT', { trackId, heightPx })
    },

    /** Optimistically reorder tracks; soft-replace PROJECT_STATE restores undo/redo order. */
    reorderTrack(trackId: string, newIndex: number): void {
      const currentIndex = this.tracks.findIndex((t) => t.id === trackId)
      if (currentIndex < 0) return
      const clamped = Math.max(0, Math.min(this.tracks.length - 1, Math.floor(newIndex)))
      if (clamped === currentIndex) return
      const [moved] = this.tracks.splice(currentIndex, 1)
      if (!moved) return
      this.tracks.splice(clamped, 0, moved)
      sendBridge('TRACK_REORDER', { trackId, newIndex: clamped })
    },

    setTrackColor(trackId: string, colorIndex: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      if (colorIndex < 0 || colorIndex >= TRACK_PALETTE.length) return
      t.colorIndex = colorIndex
      log.info('project', `setTrackColor id=${trackId} colorIndex=${colorIndex}`)
    },

    setTrackName(trackId: string, name: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      const trimmed = name.trim()
      if (trimmed.length === 0) return
      if (t.name === trimmed) return
      t.name = trimmed
      sendBridge('TRACK_RENAME', { trackId, name: trimmed })
      log.info('project', `setTrackName id=${trackId} name="${trimmed}"`)
    },
} satisfies Record<string, (this: TrackActionsThis, ...args: never[]) => unknown> &
  ThisType<TrackActionsThis>
