// Project state — the source-of-truth for what the timeline shows.
//
// Currently lives entirely in the renderer; once the JUCE backend's
// `ValueTree` + WebSocket bridge land, this store becomes a mirror of
// the backend state driven by `PROJECT_STATE` / `TRACK_ADDED` / etc.

import { defineStore } from 'pinia'
import { PEAKS_PER_SECOND } from '@/lib/audio'
import { send as sendBridge } from '@/lib/bridgeService'

export interface Clip {
  readonly id: string
  readonly trackId: string
  readonly filePath: string
  readonly fileName: string
  /** Offset from the timeline origin (ms). */
  readonly startMs: number
  readonly durationMs: number
  readonly sampleRate: number
  readonly channelCount: number
  /** Alternating min, max float pairs at PEAKS_PER_SECOND resolution. */
  readonly peaks: Float32Array
}

export interface Track {
  readonly id: string
  name: string
  clipIds: string[]
  muted: boolean
  soloed: boolean
}

interface ProjectState {
  tracks: Track[]
  clips: Record<string, Clip>
  nextTrackIndex: number
  nextClipIndex: number
}

export const useProjectStore = defineStore('project', {
  state: (): ProjectState => ({
    tracks: [],
    clips: {},
    nextTrackIndex: 1,
    nextClipIndex: 1
  }),

  getters: {
    /** Project duration in ms — the latest end of any clip, or 0. */
    durationMs(state): number {
      let max = 0
      for (const id in state.clips) {
        const c = state.clips[id]
        const end = c.startMs + c.durationMs
        if (end > max) max = end
      }
      return max
    },

    /** True if any track is currently soloed. */
    anySoloed(state): boolean {
      return state.tracks.some((t) => t.soloed)
    }
  },

  actions: {
    /**
     * Add a new track populated with a single clip starting at t=0.
     * Returns the new track's id.
     */
    addTrackFromAudio(audio: {
      filePath: string
      fileName: string
      durationMs: number
      sampleRate: number
      channelCount: number
      peaks: Float32Array
    }): string {
      const trackId = `t${this.nextTrackIndex++}`
      const clipId = `c${this.nextClipIndex++}`

      const track: Track = {
        id: trackId,
        // Default name = file stem (sans extension).
        name: audio.fileName.replace(/\.[^.]+$/, ''),
        clipIds: [clipId],
        muted: false,
        soloed: false
      }
      const clip: Clip = {
        id: clipId,
        trackId,
        filePath: audio.filePath,
        fileName: audio.fileName,
        startMs: 0,
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks
      }

      this.tracks.push(track)
      this.clips[clipId] = clip
      return trackId
    },

    /** Remove a track and all its clips, locally and on the backend. */
    removeTrack(trackId: string): void {
      const idx = this.tracks.findIndex((t) => t.id === trackId)
      if (idx < 0) return

      const track = this.tracks[idx]
      for (const clipId of track.clipIds) delete this.clips[clipId]
      this.tracks.splice(idx, 1)

      sendBridge('TRACK_REMOVE', { trackId })

      // Removing a soloed track changes audibility for everyone else.
      if (track.soloed) this.pushAllGains()
    },

    /** Toggle the mute state for one track and push the new gain to the backend. */
    toggleMute(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.muted = !t.muted
      this.pushTrackGain(t)
    },

    /**
     * Toggle the solo state. Because solo affects audibility of every other
     * track, we re-push gains for the whole project on every toggle.
     */
    toggleSolo(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.soloed = !t.soloed
      this.pushAllGains()
    },

    /** Re-push every track's effective gain to the backend (e.g. on reconnect). */
    pushAllGains(): void {
      for (const t of this.tracks) this.pushTrackGain(t)
    },

    /** Internal: compute effective gain for a track and send it. */
    pushTrackGain(track: Track): void {
      const anySolo = this.anySoloed
      const audible = !track.muted && (!anySolo || track.soloed)
      sendBridge('TRACK_GAIN', { trackId: track.id, gain: audible ? 1.0 : 0.0 })
    }
  }
})

// Re-export the constant for components that need to know the peaks resolution.
export { PEAKS_PER_SECOND }
