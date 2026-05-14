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
  /** Index into `TRACK_PALETTE`. Selects the waveform / clip-block colours. */
  colorIndex: number
}

/**
 * Fixed 16-entry palette presented in the track-header colour picker. Each
 * entry bundles three shades of one hue:
 *   - `fill`   — the clip-block body
 *   - `border` — the clip-block outline
 *   - `wave`   — the waveform peaks
 *
 * Values are 0x-prefixed numbers because that's the form PixiJS Graphics
 * APIs consume. Hues roughly follow the Tailwind palette so the swatches
 * harmonise with the rest of the UI chrome.
 */
export interface TrackPaletteEntry {
  readonly id: string
  readonly cssHex: string
  readonly fill: number
  readonly border: number
  readonly wave: number
}
export const TRACK_PALETTE: readonly TrackPaletteEntry[] = [
  { id: 'blue', cssHex: '#3b82f6', fill: 0x1e3a8a, border: 0x3b82f6, wave: 0x93c5fd },
  { id: 'red', cssHex: '#ef4444', fill: 0x7f1d1d, border: 0xef4444, wave: 0xfca5a5 },
  { id: 'orange', cssHex: '#f97316', fill: 0x7c2d12, border: 0xf97316, wave: 0xfdba74 },
  { id: 'amber', cssHex: '#f59e0b', fill: 0x78350f, border: 0xf59e0b, wave: 0xfcd34d },
  { id: 'yellow', cssHex: '#eab308', fill: 0x713f12, border: 0xeab308, wave: 0xfde047 },
  { id: 'lime', cssHex: '#84cc16', fill: 0x365314, border: 0x84cc16, wave: 0xbef264 },
  { id: 'emerald', cssHex: '#10b981', fill: 0x064e3b, border: 0x10b981, wave: 0x6ee7b7 },
  { id: 'teal', cssHex: '#14b8a6', fill: 0x134e4a, border: 0x14b8a6, wave: 0x5eead4 },
  { id: 'cyan', cssHex: '#06b6d4', fill: 0x164e63, border: 0x06b6d4, wave: 0x67e8f9 },
  { id: 'sky', cssHex: '#0ea5e9', fill: 0x0c4a6e, border: 0x0ea5e9, wave: 0x7dd3fc },
  { id: 'indigo', cssHex: '#6366f1', fill: 0x312e81, border: 0x6366f1, wave: 0xa5b4fc },
  { id: 'violet', cssHex: '#8b5cf6', fill: 0x4c1d95, border: 0x8b5cf6, wave: 0xc4b5fd },
  { id: 'fuchsia', cssHex: '#d946ef', fill: 0x701a75, border: 0xd946ef, wave: 0xf0abfc },
  { id: 'pink', cssHex: '#ec4899', fill: 0x831843, border: 0xec4899, wave: 0xf9a8d4 },
  { id: 'rose', cssHex: '#f43f5e', fill: 0x881337, border: 0xf43f5e, wave: 0xfda4af },
  { id: 'zinc', cssHex: '#a1a1aa', fill: 0x3f3f46, border: 0xa1a1aa, wave: 0xd4d4d8 }
] as const

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
        soloed: false,
        // Walk through the palette so consecutively added tracks get distinct
        // colours. Users can override per-track via the header colour picker.
        colorIndex: this.tracks.length % TRACK_PALETTE.length
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
    },

    /** Set the palette index used to draw a track's waveform / clips. */
    setTrackColor(trackId: string, colorIndex: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      if (colorIndex < 0 || colorIndex >= TRACK_PALETTE.length) return
      t.colorIndex = colorIndex
    }
  }
})

// Re-export the constant for components that need to know the peaks resolution.
export { PEAKS_PER_SECOND }
