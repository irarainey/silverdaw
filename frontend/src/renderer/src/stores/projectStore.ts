// Project state — the source-of-truth for what the timeline shows.
//
// Currently lives entirely in the renderer; once the JUCE backend's
// `ValueTree` + WebSocket bridge land, this store becomes a mirror of
// the backend state driven by `PROJECT_STATE` / `TRACK_ADDED` / etc.

import { defineStore } from 'pinia'
import { decodeAudioToPeaks, PEAKS_PER_SECOND } from '@/lib/audio'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'

export interface Clip {
  readonly id: string
  /** Host track id. Mutable because clips can be dragged between
   *  tracks; updated in lockstep with the `CLIP_MOVE { trackId }`
   *  envelope so the backend's ValueTree re-parents the clip node. */
  trackId: string
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
  /** Where inside the source file this clip begins reading (the
   *  non-destructive trim window's left edge). Mutable because
   *  left-edge trim shifts both `startMs` and `inMs` together. Defaults
   *  to 0 for newly-imported clips that haven't been trimmed. */
  inMs: number
  /** How long this clip plays from `inMs` onward (ms). Mutable so
   *  edge-drag trim can shrink it from either side. */
  durationMs: number
  /** Backend-reported sample rate. May be 0 for placeholder clips until WAVEFORM_DATA arrives. */
  sampleRate: number
  readonly channelCount: number
  /**
   * Alternating min, max float pairs at PEAKS_PER_SECOND resolution.
   * Empty for placeholder clips reconstructed from PROJECT_STATE
   * until a `WAVEFORM_DATA` binary frame fills them in.
   */
  peaks: Float32Array
  /** True when the backend's `existsAsFile` check failed for this
   *  clip's source path at load time. The drawing code renders it
   *  greyed-out and the relink toast lists it. Mutable so a successful
   *  `CLIP_RELINK` can clear it on the next PROJECT_STATE. */
  unresolved: boolean
  /** Per-clip colour-palette override (0..15). When undefined the clip
   *  inherits the host track's `colorIndex`. Set via right-click →
   *  Colour. */
  colorIndex?: number
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

async function refreshLibraryItemMedia(itemId: string, filePath: string): Promise<void> {
  const library = useLibraryStore()
  try {
    const metadata = await window.silverdaw.readAudioMetadata(filePath)
    library.setItemMetadata(itemId, metadata)
  } catch (err) {
    log.warn('library', `readAudioMetadata failed for ${filePath}: ${String(err)}`)
  }

  const item = library.getItem(itemId)
  if (!item || item.durationMs > 0) return

  try {
    const opened = await window.silverdaw.readAudioFile(filePath)
    if (!opened) return
    const decoded = await decodeAudioToPeaks(opened.data)
    library.setItemAudioDetails(itemId, decoded.durationMs, decoded.sampleRate, decoded.channelCount)
    if (item.peaks.length === 0) {
      library.setItemPeaks(itemId, decoded.peaks, decoded.sampleRate)
    }
  } catch (err) {
    log.warn('library', `readAudioFile/decode failed for ${filePath}: ${String(err)}`)
  }
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
  /**
   * Incremented whenever any clip's peaks change. Provides a single
   * shallow-reactive signal that consumers (e.g. the Pixi timeline
   * draw watch) can subscribe to without paying the cost of a deep
   * watch on every clip in the project. The clip peaks themselves are
   * mutated in place by `setClipPeaks`; this counter is what tells
   * the renderer to redraw.
   */
  peaksRevision: number

  // ─── Project file identity ───────────────────────────────────────────────
  /**
   * Absolute path of the currently-loaded `.silverdaw` file, or null if
   * the project hasn't been saved yet (newly-created or fresh launch
   * with no last project on disk).
   */
  currentFilePath: string | null
  /** User-facing project name. `Untitled` for an unsaved project. */
  projectName: string
  /**
   * True when the backend's ValueTree has been mutated since the last
   * load / save / new. Driven by `PROJECT_DIRTY { dirty }` envelopes
   * and reset to false on every PROJECT_STATE apply (a fresh snapshot
   * is by definition clean — see `applyProjectStateSnapshot`).
   */
  isDirty: boolean
  /**
   * Horizontal zoom (pixels per second) persisted with the project.
   * Mirrors `viewPxPerSecond` from PROJECT_STATE; the timeline writes
   * back here when the user wheel-zooms (debounced) so the value
   * survives File > Save / Load. `null` means "no preference yet —
   * keep the renderer's current default" (used for the initial connect
   * snapshot before any zoom has been sent).
   */
  viewPxPerSecond: number | null
  /** Persisted horizontal scroll position (px). Same `null` semantics
   *  as `viewPxPerSecond`. */
  viewScrollX: number | null

  /** Currently selected clip id (UI-only — not persisted, not sent to
   *  the backend). Used to render a thicker outline on the selected
   *  clip and to identify the target of Cut / Copy. `null` when
   *  nothing is selected. */
  selectedClipId: string | null

  /** Currently selected track id (UI-only). The selected track is the
   *  paste target — `pasteClipAtPlayhead` places the new clip on this
   *  track when set, falling back to the clipboard's source track
   *  otherwise. Drawn with a highlighted row border. */
  selectedTrackId: string | null

  /** Local cut / copy buffer. Holds the minimum data needed to mint a
   *  fresh clip via `pasteClipAtPlayhead`. Renderer-only — cleared on
   *  project load / new. */
  clipboardClip: ClipboardEntry | null

  /** Source clip id -> last duplicated clip id for repeated duplicate commands. */
  duplicateTailBySource: Record<string, string>
}

/** Snapshot of a clip's reproducible state, used by Cut / Copy / Paste. */
export interface ClipboardEntry {
  sourceTrackId: string
  /** Original clip's `startMs` on the source track — used by paste to
   *  compute "right after the source" as the target slot. */
  sourceStartMs: number
  /** Original clip's `durationMs` (separate from `durationMs` in case
   *  we ever support trimmed pastes). Currently equal. */
  sourceDurationMs: number
  filePath: string
  inMs: number
  durationMs: number
  colorIndex?: number
}

/** Default name shown in the title bar before a project is named or loaded. */
export const DEFAULT_PROJECT_NAME = 'Untitled'

/**
 * Single in-flight resolver for `saveAndWait`. Saves are serialised by
 * the unsaved-changes modal (which stays open until the ack arrives),
 * so one slot is enough. Module-level rather than store state because
 * Promise resolvers aren't serialisable into Pinia's reactivity proxy.
 */
let pendingSaveResolver: ((result: { ok: boolean; error?: string }) => void) | null = null
let pendingViewStateSaveResolver: ((result: { ok: boolean; error?: string }) => void) | null = null
let pendingSaveTimeout: ReturnType<typeof setTimeout> | null = null
const PENDING_SAVE_TIMEOUT_MS = 10000

/**
 * Return the position closest to `desiredStartMs` on `trackId` where a
 * clip of `durationMs` fits without overlapping any existing clip
 * (excluding the one identified by `excludeClipId`, which is the
 * dragged clip itself). The track timeline is decomposed into free
 * gaps; for each gap that can hold the clip we compute the closest
 * valid `startMs` and keep the best one overall.
 *
 * Picks the gap whose closest-valid position is nearest the desired
 * one — this yields "bump against the neighbour" behaviour during
 * drag (the clip slides up against the wall and stays there as long
 * as the cursor pushes that way), while still letting the user move
 * the clip to a different gap by dragging the cursor decisively past
 * the obstruction. Returns `null` if no gap is big enough.
 */
function findClipSlot(
  state: { tracks: Track[]; clips: Record<string, Clip> },
  trackId: string,
  excludeClipId: string,
  desiredStartMs: number,
  durationMs: number
): number | null {
  const track = state.tracks.find((t) => t.id === trackId)
  if (!track) return null
  // Collect occupied intervals (excluding the dragged clip).
  const intervals: { start: number; end: number }[] = []
  for (const id of track.clipIds) {
    if (id === excludeClipId) continue
    const c = state.clips[id]
    if (!c) continue
    intervals.push({ start: c.startMs, end: c.startMs + c.durationMs })
  }
  intervals.sort((a, b) => a.start - b.start)
  // Build complementary "free gaps".
  const gaps: { start: number; end: number }[] = []
  let cursor = 0
  for (const iv of intervals) {
    if (iv.start > cursor) gaps.push({ start: cursor, end: iv.start })
    cursor = Math.max(cursor, iv.end)
  }
  gaps.push({ start: cursor, end: Number.POSITIVE_INFINITY })

  const desired = Math.max(0, desiredStartMs)
  let best: number | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const g of gaps) {
    const gapLen = g.end - g.start
    if (gapLen < durationMs) continue
    const lo = g.start
    const hi = g.end === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : g.end - durationMs
    const candidate = Math.min(Math.max(desired, lo), hi)
    const dist = Math.abs(candidate - desired)
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}

export const useProjectStore = defineStore('project', {
  state: (): ProjectState => ({
    tracks: [],
    clips: {},
    peaksRevision: 0,
    currentFilePath: null,
    projectName: DEFAULT_PROJECT_NAME,
    isDirty: false,
    viewPxPerSecond: null,
    viewScrollX: null,
    selectedClipId: null,
    selectedTrackId: null,
    clipboardClip: null,
    duplicateTailBySource: {}
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
      sendBridge('TRACK_ADD', { trackId, name: track.name })
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
        inMs: 0,
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks,
        unresolved: false
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
    /**
     * Move an existing clip. Three behaviours are bundled:
     *
     *   1. Same-track move with collision prevention. Clips can't
     *      overlap on a single track, so we find the largest gap
     *      whose midpoint is closest to the desired position and
     *      clamp the new `startMs` into that gap. The clip butts
     *      flush against any neighbour it bumps into — exactly the
     *      "magnetic edge snap" the user wanted so adjacent clips
     *      play seamlessly.
     *
     *   2. Cross-track move. When `targetTrackId` differs from the
     *      clip's current host track, we re-parent the clip in the
     *      ValueTree (via the extended `CLIP_MOVE` envelope) and
     *      apply the same gap-clamp on the destination track.
     *
     *   3. Backward compatibility. Calling without `targetTrackId`
     *      keeps the existing behaviour from the drag handler.
     */
    moveClip(clipId: string, startMs: number, targetTrackId?: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const destTrackId = targetTrackId ?? clip.trackId
      const destTrack = this.tracks.find((t) => t.id === destTrackId)
      if (!destTrack) return

      // Bump-clamp into the gap nearest the desired position.
      const target = findClipSlot(this, destTrack.id, clipId, startMs, clip.durationMs)
      if (target === null) return // no gap big enough — keep current position

      const trackChanged = destTrackId !== clip.trackId
      const positionChanged = clip.startMs !== target
      if (!trackChanged && !positionChanged) return

      if (trackChanged) {
        // Remove from old track's clipIds, add to new.
        const oldTrack = this.tracks.find((t) => t.id === clip.trackId)
        if (oldTrack) {
          const idx = oldTrack.clipIds.indexOf(clipId)
          if (idx >= 0) oldTrack.clipIds.splice(idx, 1)
        }
        destTrack.clipIds.push(clipId)
        clip.trackId = destTrackId
      }
      clip.startMs = target

      // Grow the destination track to fit the new clip end.
      const clipEnd = target + clip.durationMs
      if (clipEnd > destTrack.lengthMs) destTrack.lengthMs = clipEnd

      // Single CLIP_MOVE envelope carries both the position and
      // (optionally) the new trackId. Backend re-parents the
      // ValueTree node in lockstep with the position update.
      sendBridge('CLIP_MOVE', {
        clipId: clip.id,
        positionMs: target,
        ...(trackChanged ? { trackId: destTrackId } : {})
      })
      this.peaksRevision++ // force redraw after track/position change
      log.debug(
        'project',
        `moveClip id=${clipId} -> ${target}ms${trackChanged ? ' track=' + destTrackId : ''}`
      )
    },

    /**
     * Trim a clip non-destructively. Updates `startMs`, `inMs`, and
     * `durationMs` together — the three fields form an inseparable
     * window into the underlying source file, so we send them in one
     * `CLIP_TRIM` envelope (the backend applies all three atomically).
     *
     * Caller is responsible for clamping: `inMs >= 0`, `durationMs >=
     * MIN_CLIP_MS`, `inMs + durationMs <= sourceDurationMs`. We re-clamp
     * here defensively but trust the caller's math for the dragged-edge
     * geometry.
     */
    trimClip(clipId: string, startMs: number, inMs: number, durationMs: number): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const safeStart = Math.max(0, startMs)
      const safeIn = Math.max(0, inMs)
      const safeDur = Math.max(0, durationMs)
      if (clip.startMs === safeStart && clip.inMs === safeIn && clip.durationMs === safeDur) return
      clip.startMs = safeStart
      clip.inMs = safeIn
      clip.durationMs = safeDur

      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (track) {
        const clipEnd = clip.startMs + clip.durationMs
        if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
      }

      sendBridge('CLIP_TRIM', {
        clipId: clip.id,
        startMs: safeStart,
        inMs: safeIn,
        durationMs: safeDur
      })
      log.debug(
        'project',
        `trimClip id=${clipId} start=${safeStart} in=${safeIn} dur=${safeDur}`
      )
    },

    /**
     * Split `clipId` at the given absolute timeline position `atMs`.
     * The original clip is trimmed to end at `atMs`; a new clip is
     * minted starting at `atMs` and runs to the original clip's
     * previous end. Both halves share the same underlying source file
     * (non-destructive — peaks are reused). Returns the new clip's id
     * or `null` if the split point falls outside the clip.
     */
    splitClipAt(clipId: string, atMs: number): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      // Need a strict-interior split: a split exactly at either edge
      // would mint a zero-length sibling. 1 ms of slack matches the
      // ms-precision we promised the user.
      const clipEnd = clip.startMs + clip.durationMs
      if (atMs <= clip.startMs + 1 || atMs >= clipEnd - 1) return null

      const splitOffsetInClip = atMs - clip.startMs
      const newClipDurationMs = clip.durationMs - splitOffsetInClip
      const newClipInMs = clip.inMs + splitOffsetInClip
      const newClipStartMs = atMs

      // Shrink original first (atomic three-field write).
      this.trimClip(clipId, clip.startMs, clip.inMs, splitOffsetInClip)

      // Mint the right-hand half as a new clip on the same track,
      // sharing peaks + sampleRate + channelCount with the original
      // (cheap — peaks is a shared Float32Array reference).
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return null
      const newId = crypto.randomUUID()
      const right: Clip = {
        id: newId,
        trackId: clip.trackId,
        filePath: clip.filePath,
        playbackFilePath: clip.playbackFilePath,
        fileName: clip.fileName,
        startMs: newClipStartMs,
        inMs: newClipInMs,
        durationMs: newClipDurationMs,
        sampleRate: clip.sampleRate,
        channelCount: clip.channelCount,
        peaks: clip.peaks,
        unresolved: clip.unresolved,
        colorIndex: clip.colorIndex
      }
      this.clips[newId] = right
      const insertAt = track.clipIds.indexOf(clipId)
      if (insertAt >= 0) {
        track.clipIds.splice(insertAt + 1, 0, newId)
      } else {
        track.clipIds.push(newId)
      }

      sendBridge('CLIP_ADD', {
        trackId: clip.trackId,
        clipId: newId,
        filePath: clip.filePath,
        positionMs: newClipStartMs,
        inMs: newClipInMs,
        durationMs: newClipDurationMs,
        ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {})
      })
      log.info(
        'project',
        `splitClipAt id=${clipId} at=${atMs} -> newId=${newId} (in=${newClipInMs} dur=${newClipDurationMs})`
      )
      return newId
    },

    /**
     * Duplicate `clipId` on its track. Repeated duplicate commands from
     * the same source clip append after the last duplicate in that chain
     * while leaving the original selected, so the user can build repeated
     * loop patterns without manually selecting each new copy.
     */
    duplicateClip(clipId: string): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return null
      const trackedTailId = this.duplicateTailBySource[clipId]
      const trackedTail = trackedTailId ? this.clips[trackedTailId] : null
      const tail =
        trackedTail && trackedTail.trackId === clip.trackId && track.clipIds.includes(trackedTail.id)
          ? trackedTail
          : clip
      const newStartMs = tail.startMs + tail.durationMs
      // The duplicate must fit immediately after the current tail. We do
      // not search other gaps because repeated Duplicate is an append
      // gesture; if something blocks the chain, tell the user.
      for (const id of track.clipIds) {
        if (id === clipId || id === tail.id) continue
        const c = this.clips[id]
        if (!c) continue
        const cEnd = c.startMs + c.durationMs
        if (newStartMs < cEnd && newStartMs + clip.durationMs > c.startMs) {
          useNotificationsStore().pushError('Not enough space to duplicate clip after the last duplicate.')
          log.info('project', `duplicateClip rejected: source=${clipId} tail=${tail.id} overlaps clip ${id}`)
          return null
        }
      }
      const newId = crypto.randomUUID()
      const copy: Clip = {
        id: newId,
        trackId: clip.trackId,
        filePath: clip.filePath,
        playbackFilePath: clip.playbackFilePath,
        fileName: clip.fileName,
        startMs: newStartMs,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        sampleRate: clip.sampleRate,
        channelCount: clip.channelCount,
        peaks: clip.peaks,
        unresolved: clip.unresolved,
        colorIndex: clip.colorIndex
      }
      this.clips[newId] = copy
      const insertAt = track.clipIds.indexOf(tail.id)
      if (insertAt >= 0) {
        track.clipIds.splice(insertAt + 1, 0, newId)
      } else {
        track.clipIds.push(newId)
      }
      this.duplicateTailBySource[clipId] = newId
      const clipEnd = copy.startMs + copy.durationMs
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd

      sendBridge('CLIP_ADD', {
        trackId: clip.trackId,
        clipId: newId,
        filePath: clip.filePath,
        positionMs: newStartMs,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {})
      })
      log.info('project', `duplicateClip id=${clipId} -> newId=${newId} @${newStartMs}ms`)
      return newId
    },

    /**
     * Remove a clip from its track. Optimistic — drops the clip from
     * the renderer's mirror immediately and sends `CLIP_REMOVE` to the
     * backend; the backend's `CLIP_REMOVED` ack is purely diagnostic.
     * Track `lengthMs` is left alone so removing the last clip on a
     * track doesn't collapse the project length out from under the
     * user; they can edit it explicitly in the transport bar if they
     * want to shrink.
     */
    removeClip(clipId: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (track) {
        const idx = track.clipIds.indexOf(clipId)
        if (idx >= 0) track.clipIds.splice(idx, 1)
      }
      delete this.clips[clipId]
      delete this.duplicateTailBySource[clipId]
      for (const [sourceId, tailId] of Object.entries(this.duplicateTailBySource)) {
        if (tailId === clipId) delete this.duplicateTailBySource[sourceId]
      }
      // Removing the selected clip clears the selection — otherwise we'd
      // be drawing a thicker outline around a non-existent rectangle.
      if (this.selectedClipId === clipId) this.selectedClipId = null
      this.peaksRevision++
      sendBridge('CLIP_REMOVE', { clipId })
      log.info('project', `removeClip id=${clipId}`)
    },

    /**
     * Set (or clear, with `null`) the selected clip. Selection is a
     * pure UI concept: the timeline draws the chosen clip with a
     * thicker outline, and Edit > Cut / Copy use it as the target.
     * Bumps `peaksRevision` so the canvas repaints to reflect the new
     * outline immediately.
     */
    selectClip(clipId: string | null): void {
      if (this.selectedClipId === clipId) return
      this.selectedClipId = clipId
      this.peaksRevision++
    },

    /**
     * Set (or clear, with `null`) the selected track. Selection is a
     * pure UI concept: the timeline draws a highlighted border around
     * the row, and `pasteClipAtPlayhead` uses it as the destination
     * track (falling back to the clipboard's source track when no
     * track is selected). Bumps `peaksRevision` so the highlight
     * repaints immediately.
     */
    selectTrack(trackId: string | null): void {
      if (this.selectedTrackId === trackId) return
      this.selectedTrackId = trackId
      this.peaksRevision++
    },

    /**
     * Copy the currently-selected clip to the local clipboard. Stores
     * just enough metadata to mint a new clip on paste — same source
     * file, same trim window, same colour. No-op when nothing is
     * selected. Does NOT mutate the project.
     */
    copySelectedClip(): boolean {
      const id = this.selectedClipId
      if (!id) return false
      const clip = this.clips[id]
      if (!clip) return false
      this.clipboardClip = {
        sourceTrackId: clip.trackId,
        sourceStartMs: clip.startMs,
        sourceDurationMs: clip.durationMs,
        filePath: clip.filePath,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        colorIndex: clip.colorIndex
      }
      log.info('project', `copySelectedClip id=${id}`)
      return true
    },

    /**
     * Cut the currently-selected clip — same as Copy, then remove the
     * clip from its track. The selection moves to "none" because the
     * source clip no longer exists.
     */
    cutSelectedClip(): boolean {
      const id = this.selectedClipId
      if (!id) return false
      if (!this.copySelectedClip()) return false
      this.removeClip(id)
      log.info('project', `cutSelectedClip id=${id}`)
      return true
    },

    /**
     * Paste the clipboard clip. Behaviour splits on target track:
     *
     *   - Same track as the source: lands immediately after the
     *     source clip's end position (so repeated Ctrl+V builds a
     *     back-to-back sequence).
     *
     *   - Different track (user selected another row): lands at the
     *     current playhead position. The "after the source" rule
     *     doesn't carry across tracks — the user picked the
     *     destination explicitly, and the playhead is the obvious
     *     local landing point.
     *
     * In either case the slot has to be free on the target track —
     * we never overwrite or push another clip. If the slot is taken,
     * the paste is rejected with a toast.
     */
    pasteClipAtPlayhead(positionMs?: number): string | null {
      const cb = this.clipboardClip
      if (!cb) return null
      const targetTrackId = this.selectedTrackId ?? cb.sourceTrackId
      const track = this.tracks.find((t) => t.id === targetTrackId)
      if (!track) {
        log.warn('project', `pasteClip: target track ${targetTrackId} no longer exists`)
        useNotificationsStore().pushError("Can't paste — target track has been removed.")
        return null
      }
      // Position depends on whether we're pasting onto the source
      // track or a different one.
      const targetStartMs =
        targetTrackId === cb.sourceTrackId
          ? cb.sourceStartMs + cb.sourceDurationMs
          : Math.max(0, positionMs ?? 0)
      for (const id of track.clipIds) {
        const c = this.clips[id]
        if (!c) continue
        const cEnd = c.startMs + c.durationMs
        if (targetStartMs < cEnd && targetStartMs + cb.durationMs > c.startMs) {
          useNotificationsStore().pushError('Not enough space to paste clip on this track.')
          log.info(
            'project',
            `pasteClip rejected: target=${targetStartMs} dur=${cb.durationMs} overlaps clip ${id} on ${targetTrackId}`
          )
          return null
        }
      }
      const newId = crypto.randomUUID()
      const startMs = targetStartMs
      const fileName = filePathToDisplayName(cb.filePath)
      const placeholder: Clip = {
        id: newId,
        trackId: track.id,
        filePath: cb.filePath,
        playbackFilePath: cb.filePath,
        fileName,
        startMs,
        inMs: cb.inMs,
        durationMs: cb.durationMs,
        sampleRate: 0,
        channelCount: 0,
        peaks: new Float32Array(0),
        unresolved: false,
        colorIndex: cb.colorIndex
      }
      const peakSource = Object.values(this.clips).find(
        (c) => c.filePath === cb.filePath && c.peaks.length > 0
      )
      if (peakSource) {
        placeholder.peaks = peakSource.peaks
        placeholder.sampleRate = peakSource.sampleRate
      }
      this.clips[newId] = placeholder
      track.clipIds.push(newId)
      const clipEnd = startMs + cb.durationMs
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
      this.selectedClipId = newId
      this.peaksRevision++

      sendBridge('CLIP_ADD', {
        trackId: track.id,
        clipId: newId,
        filePath: cb.filePath,
        positionMs: startMs,
        inMs: cb.inMs,
        durationMs: cb.durationMs,
        ...(cb.colorIndex !== undefined ? { colorIndex: cb.colorIndex } : {})
      })
      log.info('project', `pasteClip newId=${newId} @${startMs}ms`)
      return newId
    },

    /**
     * Set or clear a clip's per-clip colour override. `colorIndex`
     * must be in `0..TRACK_PALETTE.length-1`; pass `null` to clear
     * the override so the clip re-inherits its host track's colour.
     * Sent over the bridge as `CLIP_COLOR` so the choice persists with
     * the project.
     */
    setClipColor(clipId: string, colorIndex: number | null): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (colorIndex === null) {
        if (clip.colorIndex === undefined) return
        clip.colorIndex = undefined
        // Reuse the generic redraw counter so the timeline repaints the
        // clip with its new (inherited) palette colour. The name is
        // historical — it's now the "anything-non-positional changed"
        // signal the canvas listens to.
        this.peaksRevision++
        sendBridge('CLIP_COLOR', { clipId, colorIndex: -1 })
        log.info('project', `setClipColor id=${clipId} -> inherit`)
        return
      }
      const clamped = Math.max(0, Math.min(TRACK_PALETTE.length - 1, Math.round(colorIndex)))
      if (clip.colorIndex === clamped) return
      clip.colorIndex = clamped
      this.peaksRevision++
      sendBridge('CLIP_COLOR', { clipId, colorIndex: clamped })
      log.info('project', `setClipColor id=${clipId} -> ${clamped}`)
    },

    /** Re-point an unresolved clip at a replacement file. The backend
     *  updates the clip's filePath in the project tree, recreates the
     *  audio source, and broadcasts a fresh PROJECT_STATE which will
     *  clear `unresolved` for this clip on the next snapshot apply. */
    relinkClip(clipId: string, filePath: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      sendBridge('CLIP_RELINK', { clipId, filePath })
      log.info('project', `relinkClip id=${clipId} -> ${filePath}`)
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
      if (t.name === trimmed) return
      t.name = trimmed
      sendBridge('TRACK_RENAME', { trackId, name: trimmed })
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
        `applyProjectStateSnapshot tracks=${snapshot.tracks.length} clips=${snapshot.tracks.reduce((n, t) => n + t.clips.length, 0)} reset=${snapshot.reset === true} path=${snapshot.filePath ?? 'null'} name=${snapshot.name}`
      )
      // Stashed length applied at the end, after tracks have been
      // reconciled (the setter writes to each track's lengthMs).
      let pendingProjectLengthMs: number | null = null
      // Adopt the project identity fields up front so any code that reads
      // them during the snapshot apply (e.g. the title bar) sees the
      // post-load values. A fresh snapshot is by definition clean — any
      // mutation made AFTER it lands will flip dirty back to true via
      // a follow-up PROJECT_DIRTY envelope.
      this.currentFilePath = snapshot.filePath
      this.projectName = snapshot.name?.trim() ? snapshot.name : DEFAULT_PROJECT_NAME
      this.isDirty = false
      // Adopt the persisted zoom level (if the backend supplied one) so
      // the TimelineView watcher in the component can apply it via the
      // grid-geometry composable.
      this.viewPxPerSecond =
        typeof snapshot.viewPxPerSecond === 'number' && snapshot.viewPxPerSecond > 0
          ? snapshot.viewPxPerSecond
          : null
      this.viewScrollX =
        typeof snapshot.viewScrollX === 'number' && snapshot.viewScrollX >= 0
          ? snapshot.viewScrollX
          : null
      // BPM, playhead, and project length live on other stores. Apply
      // them here so a single PROJECT_STATE round-trip restores every
      // persisted dimension of the project view in one go.
      if (typeof snapshot.bpm === 'number' && snapshot.bpm > 0) {
        useTransportStore().setBpm(snapshot.bpm)
      }
      if (typeof snapshot.playheadMs === 'number' && snapshot.playheadMs >= 0) {
        useTransportStore().setPosition(snapshot.playheadMs)
      }
      if (typeof snapshot.projectLengthMs === 'number' && snapshot.projectLengthMs > 0) {
        // Defer to after track reconciliation below so `setProjectLengthMs`
        // sees the tracks it needs to set the length on. Stash here.
        pendingProjectLengthMs = snapshot.projectLengthMs
      } else {
        pendingProjectLengthMs = null
      }

      const library = useLibraryStore()
      // PROJECT_LOAD / PROJECT_NEW set `reset=true`. In that case the
      // renderer's optimistic mirror must be wiped before re-applying so
      // we don't carry stale tracks/clips/library items from the
      // previous project. The connect-time path leaves `reset` falsy
      // and the snapshot is treated as additive (see comment below).
      if (snapshot.reset === true) {
        this.tracks = []
        this.clips = {}
        this.selectedClipId = null
        this.selectedTrackId = null
        this.clipboardClip = null
        this.duplicateTailBySource = {}
        this.peaksRevision++
        library.clear()
      }

      // Hydrate persisted library entries BEFORE the clip-driven path
      // below runs — clips that point at the same filePath will then
      // see the existing item and skip the duplicate-add branch. We
      // pass `fromSnapshot: true` so the libraryStore doesn't echo
      // these adds back as LIBRARY_ADD envelopes.
      if (snapshot.library) {
        for (const item of snapshot.library) {
          if (library.items.some((i) => i.filePath === item.filePath)) continue
          const libId = library.addItem({
            id: item.id,
            filePath: item.filePath,
            fileName: item.fileName?.trim() ? item.fileName : filePathToBasename(item.filePath),
            durationMs: Math.max(0, item.durationMs ?? 0),
            sampleRate: Math.max(0, item.sampleRate ?? 0),
            channelCount: Math.max(0, item.channelCount ?? 0),
            peaks: new Float32Array(0),
            key: item.key,
            // The decoded-WAV cache is a backend-internal
            // optimisation. The renderer always sends the source
            // `filePath` in CLIP_ADD; the backend swaps in its
            // cached WAV on the engine side. So we deliberately do
            // NOT hydrate `playbackFilePath` from the persisted
            // cache path here — using it would make the renderer
            // send the cache path in CLIP_ADD and break the
            // backend's library-item lookup.
            playbackFilePath: item.filePath,
            fromSnapshot: true
          })
          // Hydrate persisted analysis results (if the backend has
          // detected BPM + beats on a previous session). New imports
          // get the full analysis via the LIBRARY_ITEM_ANALYSIS
          // envelope when the worker finishes.
          if (typeof item.bpm === 'number' && item.bpm > 0) {
            const persistedBeats = Array.isArray(item.beats) ? item.beats : []
            const anchor =
              typeof item.beatAnchorSec === 'number'
                ? item.beatAnchorSec
                : (persistedBeats[0] ?? 0)
            library.setItemAnalysis(
              libId,
              item.bpm,
              anchor,
              persistedBeats,
              item.variableTempo === true,
              item.playbackFilePath
            )
          }
          // Fetch tags + technical duration asynchronously so older
          // project files that predate persisted library duration still
          // repaint their tiles with the real length after reload.
          void refreshLibraryItemMedia(libId, item.filePath)
        }
      }

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
          const persistedName = t.name?.trim()
          track = {
            id: t.id,
            name: persistedName && persistedName.length > 0 ? persistedName : `Track ${index + 1}`,
            clipIds: [],
            muted: false,
            soloed: false,
            volume: Math.min(1, Math.max(0, t.gain)),
            colorIndex: index % TRACK_PALETTE.length,
            lengthMs: DEFAULT_TRACK_LENGTH_MS
          }
          this.tracks.push(track)
        } else {
          const persistedName = t.name?.trim()
          if (persistedName && persistedName.length > 0) {
            track.name = persistedName
          }
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
              playbackFilePath: c.filePath,
              // Reconstructed from a backend snapshot — don't echo a
              // LIBRARY_ADD back; the backend already has this item
              // implicitly via the clip's filePath, and an explicit
              // add would force the dirty flag on every connect.
              fromSnapshot: true
            })
            // Fetch tags + technical duration asynchronously so the
            // library card shows cover art, title and real length after
            // reload. Fire-and-forget; failures leave the placeholder
            // details in place.
            void refreshLibraryItemMedia(libId, c.filePath)
          } else if (existingLib.durationMs <= 0 && c.durationMs > 0) {
            library.setItemAudioDetails(existingLib.id, c.durationMs, 0, 0)
          }
          const existing = this.clips[c.id]
          if (existing) {
            existing.startMs = offset
            existing.inMs = Math.max(0, c.inMs ?? 0)
            existing.durationMs = Math.max(0, c.durationMs)
            existing.unresolved = c.unresolved === true
            existing.colorIndex = typeof c.colorIndex === 'number' ? c.colorIndex : undefined
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
            inMs: Math.max(0, c.inMs ?? 0),
            durationMs: Math.max(0, c.durationMs),
            sampleRate: 0,
            channelCount: 0,
            peaks: new Float32Array(0),
            unresolved: c.unresolved === true,
            colorIndex: typeof c.colorIndex === 'number' ? c.colorIndex : undefined
          }
          this.clips[c.id] = placeholder
          track.clipIds.push(c.id)
          // Unresolved clips can't produce peaks (the file is gone)
          // so don't request them — saves a futile round-trip and a
          // backend warn log per missing clip.
          if (!placeholder.unresolved) clipsNeedingPeaks.push(c.id)
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

      // Apply the persisted project length AFTER track reconciliation —
      // `setProjectLengthMs` writes to each track's `lengthMs`, so the
      // tracks have to exist first. The setter clamps upward if a clip
      // extends past the requested length, so passing a value that
      // disagrees with the on-disk tracks degrades gracefully.
      if (pendingProjectLengthMs !== null && this.tracks.length > 0) {
        this.setProjectLengthMs(pendingProjectLengthMs)
      }
    },

    // ─── Project file lifecycle (Phase 3) ──────────────────────────────────

    /** Send PROJECT_NEW; backend wipes its state and broadcasts a fresh reset snapshot. */
    requestNewProject(): void {
      log.info('project', 'requestNewProject')
      sendBridge('PROJECT_NEW')
    },

    /**
     * Send PROJECT_SAVE if we have a current path, otherwise fall through
     * to PROJECT_SAVE_AS via the OS dialog. The dialog flow runs in
     * `App.vue::handleMenuAction` because it owns the IPC context.
     */
    requestSave(): boolean {
      if (!this.currentFilePath) return false
      log.info('project', `requestSave path=${this.currentFilePath}`)
      const sent = sendBridge('PROJECT_SAVE', {
        filePath: this.currentFilePath,
        viewScrollX: this.viewScrollX ?? undefined
      })
      if (!sent) {
        useNotificationsStore().pushError('Save failed: backend is not connected.')
      }
      return true
    },

    /** Send PROJECT_SAVE_AS with the path the user picked in the OS dialog. */
    requestSaveAs(filePath: string): void {
      log.info('project', `requestSaveAs path=${filePath}`)
      const sent = sendBridge('PROJECT_SAVE_AS', { filePath, viewScrollX: this.viewScrollX ?? undefined })
      if (!sent) {
        useNotificationsStore().pushError('Save failed: backend is not connected.')
      }
    },

    /**
     * Promise-returning save that resolves once the backend acks with
     * `PROJECT_SAVED`. Used by the unsaved-changes prompt to chain
     * "save → proceed with New/Open/Quit" deterministically. Failure
     * results carry an error message; the caller surfaces it.
     */
    saveAndWait(filePath: string, isSaveAs: boolean): Promise<{ ok: boolean; error?: string }> {
      // Resolve any previous outstanding wait (its envelope never came
      // back — could happen on a backend restart). Bias toward unblocking
      // the UI rather than waiting forever.
      if (pendingSaveResolver) pendingSaveResolver({ ok: false, error: 'Superseded by a newer save' })
      if (pendingSaveTimeout) {
        clearTimeout(pendingSaveTimeout)
        pendingSaveTimeout = null
      }
      const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        pendingSaveResolver = resolve
        pendingSaveTimeout = setTimeout(() => {
          pendingSaveTimeout = null
          if (!pendingSaveResolver) return
          pendingSaveResolver({ ok: false, error: 'Timed out waiting for backend save acknowledgement' })
          pendingSaveResolver = null
        }, PENDING_SAVE_TIMEOUT_MS)
      })
      const sent = isSaveAs
        ? sendBridge('PROJECT_SAVE_AS', { filePath, viewScrollX: this.viewScrollX ?? undefined })
        : sendBridge('PROJECT_SAVE', { filePath, viewScrollX: this.viewScrollX ?? undefined })
      if (!sent) {
        if (pendingSaveTimeout) {
          clearTimeout(pendingSaveTimeout)
          pendingSaveTimeout = null
        }
        pendingSaveResolver?.({ ok: false, error: 'Backend is not connected' })
        pendingSaveResolver = null
      }
      return promise
    },

    /**
     * Called by `bridgeService` on every PROJECT_SAVED. Resolves any
     * outstanding `saveAndWait` so the unsaved-changes flow can
     * proceed. No-op if no wait is pending (a fire-and-forget save
     * fired by `requestSave` doesn't open a promise).
     */
    notifySaveAck(ok: boolean, error?: string): void {
      if (pendingSaveTimeout) {
        clearTimeout(pendingSaveTimeout)
        pendingSaveTimeout = null
      }
      if (pendingSaveResolver) {
        pendingSaveResolver({ ok, error })
        pendingSaveResolver = null
      }
    },

    saveViewStateAndWait(): Promise<{ ok: boolean; error?: string }> {
      if (!this.currentFilePath) return Promise.resolve({ ok: true })
      if (pendingViewStateSaveResolver) {
        pendingViewStateSaveResolver({ ok: false, error: 'Superseded by a newer view-state save' })
      }
      const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        pendingViewStateSaveResolver = resolve
      })
      sendBridge('PROJECT_SAVE_VIEW_STATE', {
        filePath: this.currentFilePath,
        viewScrollX: this.viewScrollX ?? 0
      })
      return promise
    },

    notifyViewStateSaveAck(ok: boolean, error?: string): void {
      if (pendingViewStateSaveResolver) {
        pendingViewStateSaveResolver({ ok, error })
        pendingViewStateSaveResolver = null
      }
    },

    /** Send PROJECT_LOAD with the path the user picked in the OS dialog. */
    requestLoad(filePath: string): void {
      log.info('project', `requestLoad path=${filePath}`)
      sendBridge('PROJECT_LOAD', { filePath })
    },

    /**
     * Rename the project. Updates the local name optimistically so the
     * title bar reflects the new value immediately, then notifies the
     * backend so the change is included in the next save.
     */
    requestRename(name: string): void {
      const trimmed = name.trim()
      const finalName = trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_NAME
      this.projectName = finalName
      sendBridge('PROJECT_RENAME', { name: finalName })
      log.info('project', `requestRename name=${finalName}`)
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
