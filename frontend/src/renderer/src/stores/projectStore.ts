// Project state — the source-of-truth for what the timeline shows.
//
// Currently lives entirely in the renderer; once the JUCE backend's
// `ValueTree` + WebSocket bridge land, this store becomes a mirror of
// the backend state driven by `PROJECT_STATE` / `TRACK_ADDED` / etc.

import { defineStore } from 'pinia'
import { PEAKS_PER_SECOND } from '@/lib/audio'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore } from '@/stores/libraryStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'

export interface Clip {
  readonly id: string
  readonly trackId: string
  readonly filePath: string
  /**
   * Path the *backend* loads for playback. Differs from `filePath` only
   * when the source format isn't natively decodable by JUCE
   * (e.g. AAC / M4A on Windows) and we hand the engine a transcoded
   * temp WAV instead. Used to match `CLIP_ADDED` / `CLIP_ADD_FAILED`
   * acks back to the originating clip in the renderer.
   */
  readonly playbackFilePath?: string
  readonly fileName: string
  /** Offset from the timeline origin (ms). Mutable so clips can be dragged. */
  startMs: number
  readonly durationMs: number
  /** Backend-reported sample rate. May be 0 for placeholder clips until WAVEFORM_DATA arrives. */
  sampleRate: number
  readonly channelCount: number
  /**
   * Alternating min, max float pairs at PEAKS_PER_SECOND resolution.
   * Empty for placeholder clips reconstructed from PROJECT_STATE
   * until a `WAVEFORM_DATA` binary frame fills them in.
   */
  peaks: Float32Array
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
  /**
   * Incremented whenever any clip's peaks change. Provides a single
   * shallow-reactive signal that consumers (e.g. the Pixi timeline
   * draw watch) can subscribe to without paying the cost of a deep
   * watch on every clip in the project. The clip peaks themselves are
   * mutated in place by `setClipPeaks`; this counter is what tells
   * the renderer to redraw.
   */
  peaksRevision: number
}

export const useProjectStore = defineStore('project', {
  state: (): ProjectState => ({
    tracks: [],
    clips: {},
    peaksRevision: 0
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
        if (!c) continue
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
      // UUID rather than a counter so the id is unique across renderer
      // reloads, multiple windows, and future project save/load. The
      // display name still uses the running count.
      const trackId = crypto.randomUUID()
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
      // Inform the backend so it can record the structural track in its
      // ValueTree. The renderer doesn't wait for the ack — `TRACK_ADDED`
      // is purely diagnostic (the renderer already shows the track).
      sendBridge('TRACK_ADD', { trackId })
      log.info('project', `addTrack id=${trackId}`)
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
        /** Optional backend-loadable path; falls back to `filePath`. */
        playbackFilePath?: string
      },
      startMs = 0
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null

      const clipId = crypto.randomUUID()
      const clip: Clip = {
        id: clipId,
        trackId,
        filePath: audio.filePath,
        playbackFilePath: audio.playbackFilePath,
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

      sendBridge('CLIP_MOVE', { clipId: clip.id, positionMs: snapped })
      log.debug('project', `moveClip id=${clipId} -> ${snapped}ms`)
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
        /** Optional backend-loadable path; falls back to `filePath`. */
        playbackFilePath?: string
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
        clipId,
        filePath: libraryItem.playbackFilePath ?? libraryItem.filePath,
        positionMs: snapped
      })
      log.info('project', `addClipFromLibrary track=${trackId} clip=${clipId} pos=${snapped}ms`)
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
      if (!track) return
      for (const clipId of track.clipIds) delete this.clips[clipId]
      this.tracks.splice(idx, 1)

      sendBridge('TRACK_REMOVE', { trackId })

      // Removing a soloed track changes audibility for everyone else.
      if (track.soloed) this.pushAllGains()
      log.info('project', `removeTrack id=${trackId}`)
    },

    /** Toggle the mute state for one track and push the new gain to the backend. */
    toggleMute(trackId: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.muted = !t.muted
      log.info('project', `toggleMute id=${trackId} muted=${t.muted}`)
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
      log.info('project', `toggleSolo id=${trackId} soloed=${t.soloed}`)
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
     *
     * Use this for *commits* (e.g. the slider's `@change` event). For the
     * live drag (every `@input`) use `setTrackVolumeLocal` so we don't
     * flood the bridge with one envelope per pixel of slider movement.
     */
    setTrackVolume(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(1, Math.max(0, volume))
      log.debug('project', `setTrackVolume id=${trackId} volume=${t.volume}`)
      this.pushTrackGain(t)
    },

    /**
     * Update a track's volume *locally only* — used by the slider's
     * `@input` event so the UI feels immediate without pushing one
     * `TRACK_GAIN` envelope per pixel of movement. The committed value
     * goes out on `@change` via `setTrackVolume`.
     */
    setTrackVolumeLocal(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(1, Math.max(0, volume))
    },

    /**
     * Reconcile a `CLIP_ADDED` / `CLIP_ADD_FAILED` ack from the backend
     * against the optimistically-added clip in the renderer.
     *
     * - On success the clip stays put (the backend now has a matching
     *   `Track`/`Clip` and will produce audio).
     * - On failure we drop the clip and surface a toast so the user
     *   sees *why* their drop-target file didn't make it (codec
     *   unsupported, file missing, etc.). Matching is by `clipId` —
     *   the bridge ack echoes back the id the renderer assigned at
     *   send time.
     */
    confirmClipAdd(trackId: string, clipId: string, ok: boolean, error?: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (ok) {
        // No state change needed — the optimistic clip is now confirmed.
        return
      }
      const track = this.tracks.find((t) => t.id === trackId)
      delete this.clips[clipId]
      if (track) {
        track.clipIds = track.clipIds.filter((id) => id !== clipId)
      }
      const message = error
        ? `Couldn't add clip: ${error}`
        : 'Couldn\u2019t add clip (backend rejected the file).'
      useNotificationsStore().pushError(message)
    },

    /** Set the palette index used to draw a track's waveform / clips. */
    setTrackColor(trackId: string, colorIndex: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      if (colorIndex < 0 || colorIndex >= TRACK_PALETTE.length) return
      t.colorIndex = colorIndex
      log.info('project', `setTrackColor id=${trackId} colorIndex=${colorIndex}`)
    },

    /**
     * Rename a track. Whitespace is trimmed; empty names are rejected so
     * the header column always has something to display. Does not touch
     * any clip names — those keep their per-clip labels.
     */
    setTrackName(trackId: string, name: string): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      const trimmed = name.trim()
      if (trimmed.length === 0) return
      t.name = trimmed
      log.info('project', `setTrackName id=${trackId} name="${trimmed}"`)
    },

    /**
     * Apply a backend-authoritative `PROJECT_STATE` snapshot. Called once
     * per connection right after AUTH succeeds (see `bridgeService`).
     *
     * Semantics:
     *   - For every clip the backend knows about that the renderer also
     *     has (matched by `clipId`): update `startMs` to the backend
     *     value so the timeline reflects backend truth.
     *   - For every clip the renderer has that the backend does NOT
     *     know about: drop it. The backend is the source of truth — a
     *     renderer-side clip with no backend twin can't be played.
     *   - For every clip the backend has that the renderer does NOT
     *     know about: log a warning and skip. The renderer can't draw
     *     it (no waveform peaks yet) — backend-supplied peaks land in
     *     the Phase 1 `backend-waveform-data` todo, which is when this
     *     branch becomes a "rehydrate from backend" reconnect-recovery
     *     path.
     *
     * Track gains are not reconciled here (the renderer's mute/solo/
     * volume model is the source of truth for audibility and will
     * re-push gains via `pushAllGains` on reconnect if needed).
     */
    /**
     * Replace a clip's waveform peaks. Called by the bridge service when
     * a `WAVEFORM_DATA` binary frame arrives — either as a result of a
     * just-added clip's auto-broadcast from the backend, or in response
     * to a `WAVEFORM_REQUEST` the renderer sent during snapshot
     * rehydrate. Silent no-op for unknown clipIds (the clip may have
     * been removed between request and response).
     */
    setClipPeaks(clipId: string, peaks: Float32Array, sampleRate: number): void {
      const clip = this.clips[clipId]
      if (!clip) return
      clip.peaks = peaks
      if (sampleRate > 0) clip.sampleRate = sampleRate
      // Tick the global peaks revision so consumers redraw. A single
      // counter is much cheaper than a `deep: true` watch on `clips`,
      // and the redraw cost is amortised across however many clips
      // get their peaks in one PROJECT_STATE rehydrate cycle.
      this.peaksRevision++
      // Also refresh the matching library item's peaks (and sample
      // rate) so the library card shows the waveform after a reload.
      // The two never disagree because both are keyed off `filePath`.
      const lib = useLibraryStore()
      const item = lib.items.find((i) => i.filePath === clip.filePath)
      if (item && item.peaks.length === 0) {
        lib.setItemPeaks(item.id, peaks, sampleRate)
      }
      log.debug('project', `setClipPeaks id=${clipId} peaks=${peaks.length / 2} sr=${sampleRate}`)
    },

    applyProjectStateSnapshot(snapshot: ProjectStatePayload): void {
      log.info(
        'project',
        `applyProjectStateSnapshot tracks=${snapshot.tracks.length} clips=${snapshot.tracks.reduce((n, t) => n + t.clips.length, 0)}`
      )
      const library = useLibraryStore()
      // Collect ids of clips that still need peaks after reconciliation so
      // we can fire WAVEFORM_REQUESTs at the end in one pass.
      const clipsNeedingPeaks: string[] = []
      for (const t of snapshot.tracks) {
        // Reconstruct any track the backend knows but the renderer doesn't
        // (e.g. after a renderer reload). Audio is already live on the
        // backend; this rebuilds the visual representation so the user
        // sees what's playing. Display name + colour use the position in
        // the snapshot so they're deterministic across reloads.
        let track = this.tracks.find((x) => x.id === t.id)
        if (!track) {
          const index = this.tracks.length
          track = {
            id: t.id,
            name: `Track ${index + 1}`,
            clipIds: [],
            muted: false,
            soloed: false,
            volume: Math.min(1, Math.max(0, t.gain)),
            colorIndex: index % TRACK_PALETTE.length,
            lengthMs: DEFAULT_TRACK_LENGTH_MS
          }
          this.tracks.push(track)
        }
        for (const c of t.clips) {
          const offset = Math.max(0, c.offsetMs)
          // Ensure a library entry exists for this clip's source file. The
          // library is otherwise renderer-only state and would be empty
          // after a reload; we rebuild it from the backend-known clip
          // filePaths so dragging the same sample to another track still
          // works post-reload. Peaks fill in once WAVEFORM_DATA arrives;
          // sampleRate / channelCount aren't known at this point and stay
          // 0 until then.
          const existingLib = library.items.find((i) => i.filePath === c.filePath)
          if (!existingLib) {
            const libId = library.addItem({
              filePath: c.filePath,
              fileName: filePathToBasename(c.filePath),
              durationMs: Math.max(0, c.durationMs),
              sampleRate: 0,
              channelCount: 0,
              peaks: new Float32Array(0),
              playbackFilePath: c.filePath
            })
            // Fetch ID3 / Vorbis / iTunes tags asynchronously so the
            // library card shows the cover art + title after reload
            // (same data path the import flow uses). Fire-and-forget;
            // failures degrade silently to "no metadata".
            void window.silverdaw
              .readAudioMetadata(c.filePath)
              .then((metadata) => library.setItemMetadata(libId, metadata))
              .catch((err) => log.warn('library', `readAudioMetadata failed for ${c.filePath}: ${String(err)}`))
          }
          const existing = this.clips[c.id]
          if (existing) {
            existing.startMs = offset
            if (existing.peaks.length === 0) clipsNeedingPeaks.push(c.id)
            continue
          }
          // Reconstruct a placeholder clip the renderer can draw at the
          // correct timeline position and width. Waveform peaks are
          // requested separately below.
          const fileName = filePathToDisplayName(c.filePath)
          const placeholder: Clip = {
            id: c.id,
            trackId: t.id,
            filePath: c.filePath,
            playbackFilePath: c.filePath,
            fileName,
            startMs: offset,
            durationMs: Math.max(0, c.durationMs),
            sampleRate: 0,
            channelCount: 0,
            peaks: new Float32Array(0)
          }
          this.clips[c.id] = placeholder
          track.clipIds.push(c.id)
          clipsNeedingPeaks.push(c.id)
          const clipEnd = placeholder.startMs + placeholder.durationMs
          if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
          if (track.clipIds.length === 1 && /^Track \d+$/.test(track.name)) {
            track.name = fileName
          }
        }
      }
      // PROJECT_STATE is *additive only*. We do NOT drop optimistic
      // tracks/clips that aren't in the snapshot:
      //
      //   - Renderer creates `t1` (optimistic) and queues TRACK_ADD.
      //   - Backend sends the post-AUTH PROJECT_STATE from the message
      //     thread; that snapshot is taken BEFORE the queued TRACK_ADD
      //     has been processed, so it doesn't include `t1`.
      //   - Wiping `t1` here would be a data-loss bug — the user just
      //     made it.
      //
      // The renderer's own action flow (`confirmClipAdd` for failed
      // adds, `removeTrack` for user-driven removal) is responsible for
      // dropping state. PROJECT_STATE only adds backend-known state the
      // renderer doesn't already have.
      //
      // Request peaks for every clip that doesn't have any. The backend
      // serves cached peaks instantly or kicks the worker pool; either
      // way the response is a WAVEFORM_DATA binary frame that
      // `setClipPeaks` consumes.
      for (const clipId of clipsNeedingPeaks) {
        sendBridge('WAVEFORM_REQUEST', { clipId })
      }
    }
  }
})

/**
 * Derive a clip's display name from its backend file path. Strips the
 * directory and file extension; falls back to the full string if either
 * step can't apply.
 */
function filePathToDisplayName(filePath: string): string {
  // Handle both Windows backslash and POSIX forward-slash separators.
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const basename = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath
  const lastDot = basename.lastIndexOf('.')
  return lastDot > 0 ? basename.slice(0, lastDot) : basename
}

/**
 * Same as {@link filePathToDisplayName} but keeps the extension. Used for
 * library item filenames where users expect to see "track.mp3" rather
 * than just "track".
 */
function filePathToBasename(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath
}

// Re-export the constant for components that need to know the peaks resolution.
export { PEAKS_PER_SECOND }
