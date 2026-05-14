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
  /** Offset from the timeline origin (ms). Mutable so clips can be dragged. */
  startMs: number
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
  /** Per-track volume as a linear gain (0.0 = silent, 1.0 = unity). */
  volume: number
  /** Index into `TRACK_PALETTE`. Selects the waveform / clip-block colours. */
  colorIndex: number
  /**
   * Visible length of the track in ms. New tracks default to
   * `DEFAULT_TRACK_LENGTH_MS`; if a longer file is imported the track grows
   * to fit it. This is what drives `durationMs` for the timeline ruler /
   * scroll extent.
   */
  lengthMs: number
}

/** Default visible length of a new empty track — 10 minutes. */
export const DEFAULT_TRACK_LENGTH_MS = 10 * 60 * 1000

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
    /**
     * Project duration in ms. The timeline always shows at least the longest
     * track's `lengthMs`, plus whatever a clip at the end of a track might
     * extend past that.
     */
    durationMs(state): number {
      let max = 0
      for (const t of state.tracks) {
        if (t.lengthMs > max) max = t.lengthMs
      }
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
     * Add a new empty track. The track shows up immediately in the timeline
     * with the default visible length; clips can be imported into it later
     * via `addClipToTrack`. Returns the new track's id.
     */
    addTrack(): string {
      const trackId = `t${this.nextTrackIndex++}`
      const track: Track = {
        id: trackId,
        name: `Track ${this.tracks.length + 1}`,
        clipIds: [],
        muted: false,
        soloed: false,
        volume: 1.0,
        // Rotate through the palette so consecutive new tracks get distinct
        // colours. Users can override per-track via the colour picker.
        colorIndex: this.tracks.length % TRACK_PALETTE.length,
        lengthMs: DEFAULT_TRACK_LENGTH_MS
      }
      this.tracks.push(track)
      return trackId
    },

    /**
     * Add a decoded audio file as a clip on an existing track, starting at
     * the given offset (default 0). Grows the track's `lengthMs` if the clip
     * extends past the current end. Returns the new clip's id, or `null` if
     * the track wasn't found.
     */
    addClipToTrack(
      trackId: string,
      audio: {
        filePath: string
        fileName: string
        durationMs: number
        sampleRate: number
        channelCount: number
        peaks: Float32Array
      },
      startMs = 0
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null

      const clipId = `c${this.nextClipIndex++}`
      const clip: Clip = {
        id: clipId,
        trackId,
        filePath: audio.filePath,
        fileName: audio.fileName,
        startMs,
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks
      }
      this.clips[clipId] = clip
      track.clipIds.push(clipId)

      // Grow the visible track length if this clip extends past the end.
      const clipEnd = clip.startMs + clip.durationMs
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd

      // If the track was previously unnamed (default "Track N") and this is
      // its first clip, take the file stem as a more helpful label.
      if (track.clipIds.length === 1 && /^Track \d+$/.test(track.name)) {
        track.name = audio.fileName.replace(/\.[^.]+$/, '')
      }

      return clipId
    },

    /**
     * Move an existing clip to a new timeline offset (ms). Grows the host
     * track's `lengthMs` if the clip now extends past the previous end and
     * notifies the backend so playback respects the new position.
     */
    moveClip(clipId: string, startMs: number): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const snapped = Math.max(0, startMs)
      if (clip.startMs === snapped) return
      clip.startMs = snapped

      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (track) {
        const clipEnd = clip.startMs + clip.durationMs
        if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
      }

      sendBridge('CLIP_MOVE', { trackId: clip.trackId, positionMs: snapped })
    },

    /**
     * True if placing a clip of `durationMs` length on `trackId` starting at
     * `startMs` would overlap any existing clip on that track. Used by the
     * library drag-drop flow to reject drops onto occupied space.
     */
    wouldClipOverlap(trackId: string, startMs: number, durationMs: number): boolean {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return false
      const newStart = Math.max(0, startMs)
      const newEnd = newStart + durationMs
      for (const otherId of track.clipIds) {
        const other = this.clips[otherId]
        if (!other) continue
        const otherEnd = other.startMs + other.durationMs
        // Overlap if ranges intersect; touching edges (newEnd === other.startMs
        // or newStart === otherEnd) are allowed.
        if (newStart < otherEnd && newEnd > other.startMs) return true
      }
      return false
    },

    /**
     * Place a clip from the library onto a track at `startMs`. Reuses the
     * library item's already-decoded peaks (no re-decode). Sends the matching
     * `CLIP_ADD` to the backend so the audio engine loads the file too.
     *
     * Returns the new clip's id, or `null` if the track is missing or the
     * placement would overlap an existing clip on that track.
     */
    addClipFromLibrary(
      trackId: string,
      libraryItem: {
        filePath: string
        fileName: string
        durationMs: number
        sampleRate: number
        channelCount: number
        peaks: Float32Array
      },
      startMs: number
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null
      const snapped = Math.max(0, Math.floor(startMs))
      if (this.wouldClipOverlap(trackId, snapped, libraryItem.durationMs)) return null

      const clipId = this.addClipToTrack(trackId, libraryItem, snapped)
      if (!clipId) return null

      sendBridge('CLIP_ADD', {
        trackId,
        filePath: libraryItem.filePath,
        positionMs: snapped
      })
      return clipId
    },

    /**
     * Set the project's visible timeline length (ms). Updates every track's
     * `lengthMs`, but never below the end of that track's longest clip — so
     * the user can shrink the project but never clip audio off-screen.
     * No-op when there are no tracks.
     */
    setProjectLengthMs(lengthMs: number): void {
      if (this.tracks.length === 0) return
      const target = Math.max(0, Math.floor(lengthMs))
      for (const track of this.tracks) {
        let minLength = 0
        for (const clipId of track.clipIds) {
          const clip = this.clips[clipId]
          if (!clip) continue
          const end = clip.startMs + clip.durationMs
          if (end > minLength) minLength = end
        }
        track.lengthMs = Math.max(target, minLength)
      }
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
      const gain = audible ? track.volume : 0.0
      sendBridge('TRACK_GAIN', { trackId: track.id, gain })
    },

    /**
     * Set a track's volume (linear gain, 0.0–1.0) and push the new effective
     * gain to the backend. Mute / solo still override volume to silence.
     */
    setTrackVolume(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(1, Math.max(0, volume))
      this.pushTrackGain(t)
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
