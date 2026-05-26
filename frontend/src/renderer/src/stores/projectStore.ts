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
import { useUiStore } from '@/stores/uiStore'
import type { ClipWarpMode, ProjectStatePayload } from '@shared/bridge-protocol'
import type { LibraryItem } from '@/stores/libraryStore'

export interface Clip {
  readonly id: string
  /** Host track id. Mutable because clips can be dragged between
   *  tracks; updated in lockstep with the `CLIP_MOVE { trackId }`
   *  envelope so the backend's ValueTree re-parents the clip node. */
  trackId: string
  /** Source library item this clip plays from. The single source of
   *  truth for the underlying audio file — clips never carry a
   *  filesystem path. `filePath` / `fileName` / `peaks` below are
   *  cached copies sourced from the library item at creation time
   *  for cheap rendering lookups; PROJECT_STATE refreshes them when
   *  the library item is relinked. */
  libraryItemId: string
  /** Cached source-file path (== library item filePath at the time
   *  this clip was created). Read-only convenience for the drawing
   *  / drag / save code paths that don't want a library lookup on
   *  every access. */
  readonly filePath: string
  /**
   * Cached backend-loadable path (== library item playbackFilePath).
   * Used to match `CLIP_ADDED` / `CLIP_ADD_FAILED` acks back to the
   * originating clip in the renderer.
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
   * Alternating min, max float pairs. `peaksPerSecond` records the actual
   * bucket rate used to create them; it can differ slightly from the
   * requested nominal rate when sample buckets must be integer-sized.
   */
  peaks: Float32Array
  peaksPerSecond?: number
  /** True when the library item's source file no longer exists on
   *  disk. The drawing code renders the clip greyed-out and the
   *  relink toast lists it. Mutable so a successful relink can
   *  clear it on the next PROJECT_STATE. */
  unresolved: boolean
  /** Per-clip colour-palette override (0..15). When undefined the clip
   *  inherits the host track's `colorIndex`. Set via right-click →
   *  Colour. */
  colorIndex?: number
  /** User-facing display name override. Set via double-click on the
   *  clip header in the timeline. When set, this name is shown on the
   *  clip and used as the default name when saving the clip to the
   *  library. Undefined means fall back to the library item title /
   *  filename. */
  name?: string
  /** Per-clip warp + pitch-shift settings. All fields optional; an
   *  un-warped clip carries none of them. See `ClipSetWarpPayload` in
   *  the shared bridge protocol for the field semantics. `tempoRatio`
   *  undefined means "derive from project.bpm / sourceBpm live"; a
   *  finite value pins the ratio so subsequent project-BPM edits
   *  don't move this clip. */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
  /** Bookkeeping flag: clip was dropped before its library item's BPM
   *  was detected. Cleared automatically by `LIBRARY_ITEM_ANALYSIS`
   *  (auto-flip warp on) or by any manual warp edit (user opt-out). */
  pendingAutoWarp?: boolean
  /** Backend-authoritative effective timing. `durationMs` above remains
   *  source-time; this is the rendered/audible timeline footprint. */
  effectiveDurationMs?: number
  effectiveTempoRatio?: number
  effectiveWarpActive?: boolean
}

export interface Marker {
  readonly id: string
  positionMs: number
}

export interface Track {
  readonly id: string
  name: string
  clipIds: string[]
  muted: boolean
  soloed: boolean
  /** Per-track volume as a linear gain. 0.0 = silent, 1.0 = unity
   *  (the slider's mid-point), 1.5 = +50% boost (the slider's
   *  right-hand maximum). The TrackHeaderPanel fader maps its 0..1
   *  visual position onto this domain piecewise so unity sits at the
   *  middle of the bar, giving the user equal travel for cuts and
   *  boosts. */
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
  /**
   * Per-track row height in CSS pixels. User-resizable via the drag
   * handle on the bottom edge of each track header. Optional: tracks
   * loaded from a project saved before this field existed (or freshly
   * created without an explicit override) fall back to the default
   * row height from the timeline constants module.
   */
  heightPx?: number
}

/** Default visible length of a new empty track — 10 minutes. */
export const DEFAULT_TRACK_LENGTH_MS = 10 * 60 * 1000

/**
 * Upper bound on a track's linear volume. Unity (1.0) sits at the
 * mid-point of the fader so the user gets equal travel for cuts and
 * boosts; the maximum is +50% (which the backend's clamp at 4.0× lets
 * through unchanged). Saved projects clamp incoming `gain` values to
 * this domain on snapshot apply, so an older `.silverdaw` with gain
 * 1.0 still resolves to "unity at the mid-point" — no migration needed.
 */
export const MAX_TRACK_VOLUME = 1.5

/**
 * Derive a stable `projectId` from an absolute project file path. Used
 * to bucket autosave artefacts so the same file always lands in the
 * same `%APPDATA%/Silverdaw/autosave/<projectId>/` folder across
 * launches.
 *
 * Prefers `crypto.subtle.digest` (SHA-1, 8-byte prefix) and falls back
 * to a cheap deterministic string hash on environments that don't
 * expose Web Crypto (e.g. Vitest's happy-dom shim used by the store
 * specs).
 */
async function deriveProjectIdFromPath(absolutePath: string): Promise<string> {
  const lower = absolutePath.trim().toLowerCase()
  try {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle
    if (subtle) {
      const data = new TextEncoder().encode(lower)
      const digest = await subtle.digest('SHA-1', data)
      return Array.from(new Uint8Array(digest))
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch {
    // Fall through to the synchronous fallback.
  }
  // Deterministic 32-bit FNV-1a → 8 hex digits. Good enough for
  // tests; the SHA-1 path covers real users.
  let h = 0x811c9dc5
  for (let i = 0; i < lower.length; i++) {
    h ^= lower.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Generate a fresh autosave id for an untitled project. Same character
 *  set as `deriveProjectIdFromPath` so main's allow-list (a strict
 *  `[A-Za-z0-9_-]{1,64}` regex) accepts both. */
function freshUntitledProjectId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 24)
  // Test-environment fallback. Math.random() entropy is fine here —
  // collisions inside one Vitest run don't matter.
  let out = ''
  for (let i = 0; i < 24; i++) {
    out += Math.floor(Math.random() * 16).toString(16)
  }
  return out
}

function fileStem(name: string): string {
  return name.replace(/\.[^.\\/:*?"<>|]+$/, '').trim() || 'Sample'
}

function parentDir(path: string | null | undefined): string {
  if (!path) return ''
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return slash > 0 ? path.slice(0, slash) : ''
}

async function defaultSamplesDir(currentFilePath: string | null): Promise<string> {
  const projectDir = parentDir(currentFilePath)
  if (projectDir) return `${projectDir}\\Samples`
  const qol = await window.silverdaw.getQolPrefs().catch(() => null)
  const base = qol?.paths.defaultProjectDir || ''
  return base ? `${base}\\Samples` : 'Samples'
}

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
      library.setItemPeaks(itemId, decoded.peaks, decoded.sampleRate, decoded.peaksPerSecond)
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
  markers: Marker[]
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
   * Stable identifier used to bucket autosave artefacts under
   * `%APPDATA%/Silverdaw/autosave/<projectId>/`. Derived from the
   * absolute file path for saved projects (so the same file always
   * lands in the same folder across launches) and a random UUID for
   * untitled / freshly-created projects. Refreshed on every
   * PROJECT_STATE with reset=true so File > Save As switches buckets
   * cleanly. `null` until the first snapshot has been applied.
   */
  projectId: string | null
  /** Project id from the recovery manifest while an untitled recovery load is in flight. */
  pendingRecoveredProjectId: string | null
  /**
   * Snapshot of `projectId` before the most recent transition (Load,
   * New, Save As). The autosave manager uses this to delete the old
   * bucket after a successful explicit save / new without losing the
   * file that's still under the new id.
   */
  previousProjectId: string | null
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
   *  track at the playhead. Drawn with a highlighted row border. */
  selectedTrackId: string | null

  /** Local cut / copy buffer. Holds the minimum data needed to mint a
   *  fresh clip via `pasteClipAtPlayhead`. Renderer-only — cleared on
   *  project load / new. */
  clipboardClip: ClipboardEntry | null

  /** Source clip id -> last duplicated clip id for repeated duplicate commands. */
  duplicateTailBySource: Record<string, string>

  /** Mirror of the backend `juce::UndoManager` head: whether an undo /
   *  redo step is currently available. Drives the Edit > Undo / Redo
   *  menu's enabled state. Updated by `EDIT_UNDO_STATE` envelopes. */
  canUndo: boolean
  canRedo: boolean
  /** Description of the next undo / redo transaction (e.g. "Move clip").
   *  Reserved for future menu hints like "Undo Move clip"; the basic
   *  Edit menu just uses the boolean fields. `null` when the
   *  corresponding `can…` flag is false. */
  undoLabel: string | null
  redoLabel: string | null
}

/** Snapshot of a clip's reproducible state, used by Cut / Copy / Paste. */
export interface ClipboardEntry {
  sourceTrackId: string
  /** Original clip's `startMs` on the source track. Retained for
   *  future paste variants and diagnostics; paste lands at playhead. */
  sourceStartMs: number
  /** Original clip's `durationMs` (separate from `durationMs` in case
   *  we ever support trimmed pastes). Currently equal. */
  sourceDurationMs: number
  libraryItemId: string
  filePath: string
  inMs: number
  durationMs: number
  colorIndex?: number
  name?: string
  /** Warp settings carried across copy/paste so a paste preserves
   *  the source clip's tempo / pitch state. All optional — un-warped
   *  clips leave these undefined. */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
  effectiveDurationMs?: number
  effectiveTempoRatio?: number
  effectiveWarpActive?: boolean
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
let pendingRecoveryLoadResolver: ((result: { ok: boolean; error?: string }) => void) | null =
  null
let pendingRecoveryLoadTimeout: ReturnType<typeof setTimeout> | null = null
const PENDING_LOAD_TIMEOUT_MS = 10000

/**
 * Outstanding autosave resolver keyed by autosave filePath. The
 * renderer's autosave manager can have at most one tick in flight at a
 * time, but keying on path keeps the resolver robust to a tick races
 * being raced by a project replacement (the new bucket's ack should
 * not resolve the previous bucket's promise).
 */
const pendingAutosaveResolvers = new Map<
  string,
  (result: { ok: boolean; error?: string }) => void
>()

export function effectiveClipDurationMs(clip: { durationMs: number; effectiveDurationMs?: number }): number {
  return typeof clip.effectiveDurationMs === 'number' && clip.effectiveDurationMs > 0
    ? clip.effectiveDurationMs
    : clip.durationMs
}

export function effectiveClipTempoRatio(clip: { effectiveTempoRatio?: number }): number {
  return typeof clip.effectiveTempoRatio === 'number' && clip.effectiveTempoRatio > 0
    ? clip.effectiveTempoRatio
    : 1
}

export function isClipTempoWarpActive(clip: { effectiveWarpActive?: boolean }): boolean {
  return clip.effectiveWarpActive === true
}

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
  durationMs: number,
  resolveDurationMs?: (clip: Clip) => number
): number | null {
  const track = state.tracks.find((t) => t.id === trackId)
  if (!track) return null
  // Collect occupied intervals (excluding the dragged clip).
  const intervals: { start: number; end: number }[] = []
  for (const id of track.clipIds) {
    if (id === excludeClipId) continue
    const c = state.clips[id]
    if (!c) continue
    const effectiveDurationMs = resolveDurationMs ? resolveDurationMs(c) : c.durationMs
    intervals.push({ start: c.startMs, end: c.startMs + effectiveDurationMs })
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
    markers: [],
    peaksRevision: 0,
    currentFilePath: null,
    projectName: DEFAULT_PROJECT_NAME,
    isDirty: false,
    projectId: null,
    pendingRecoveredProjectId: null,
    previousProjectId: null,
    viewPxPerSecond: null,
    viewScrollX: null,
    selectedClipId: null,
    selectedTrackId: null,
    clipboardClip: null,
    duplicateTailBySource: {},
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null
  }),

  getters: {
    /**
     * Project duration in ms. The timeline always shows at least the longest
     * track's `lengthMs`, plus whatever a clip at the end of a track might
     * extend past that.
     */
    durationMs(state): number {
      // Walk every clip and compute its backend-authoritative effective
      // timeline end. Source-time duration stays on `durationMs`;
      // `effectiveDurationMs` is the rendered/audible footprint.
      let max = 0
      for (const t of state.tracks) {
        if (t.lengthMs > max) max = t.lengthMs
      }
      for (const id in state.clips) {
        const c = state.clips[id]
        if (!c) continue
        const effDur = effectiveClipDurationMs(c)
        const end = c.startMs + effDur
        if (end > max) max = end
      }
      return max
    },

    /**
     * Minimum legal project length based only on timeline clips. Track
     * display length may be longer, but user edits must never shrink the
     * ruler under the audible/visible end of the latest clip.
     */
    longestClipEndMs(state): number {
      let max = 0
      for (const id in state.clips) {
        const c = state.clips[id]
        if (!c) continue
        const effDur = effectiveClipDurationMs(c)
        const end = c.startMs + effDur
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
        libraryItemId: string
        filePath: string
        fileName: string
        durationMs: number
        sampleRate: number
        channelCount: number
        peaks: Float32Array
        peaksPerSecond?: number
        /** Optional backend-loadable path; falls back to `filePath`. */
        playbackFilePath?: string
        /** Optional source-file trim window for reusable saved clips. */
        inMs?: number
      },
      startMs = 0
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null

      const clipId = crypto.randomUUID()
      const clip: Clip = {
        id: clipId,
        trackId,
        libraryItemId: audio.libraryItemId,
        filePath: audio.filePath,
        playbackFilePath: audio.playbackFilePath,
        fileName: audio.fileName,
        startMs,
        inMs: Math.max(0, audio.inMs ?? 0),
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks,
        peaksPerSecond: audio.peaksPerSecond,
        unresolved: false
      }
      this.clips[clipId] = clip
      track.clipIds.push(clipId)

      // Grow the visible track length if this clip extends past the end.
      const clipEnd = clip.startMs + effectiveClipDurationMs(clip)
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
      const resolveDurationMs = (c: Clip): number => effectiveClipDurationMs(c)
      const target = findClipSlot(
        this,
        destTrack.id,
        clipId,
        startMs,
        resolveDurationMs(clip),
        resolveDurationMs
      )
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
      const clipEnd = target + effectiveClipDurationMs(clip)
      if (clipEnd > destTrack.lengthMs) destTrack.lengthMs = clipEnd

      // Single CLIP_MOVE envelope carries both the position and
      // (optionally) the new trackId. Backend re-parents the
      // ValueTree node in lockstep with the position update.
      sendBridge('CLIP_MOVE', {
        clipId: clip.id,
        positionMs: target,
        ...(trackChanged ? { trackId: destTrackId } : {})
      })
      if (trackChanged) this.pushTrackGain(destTrack)
      this.peaksRevision++ // force redraw after track/position change
      log.debug(
        'project',
        `moveClip id=${clipId} -> ${target}ms${trackChanged ? ' track=' + destTrackId : ''}`
      )
    },

    commitClipMove(clipId: string): void {
      const clip = this.clips[clipId]
      if (!clip) return
      sendBridge('CLIP_MOVE', {
        clipId: clip.id,
        positionMs: clip.startMs,
        commit: true
      })
      log.debug('project', `commitClipMove id=${clipId} at=${clip.startMs}ms`)
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
        const clipEnd = clip.startMs + effectiveClipDurationMs(clip)
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
      const library = useLibraryStore()
      const libItem = library.byId[clip.libraryItemId]
      if (libItem?.kind === 'saved-clip') {
        useNotificationsStore().pushError('Linked clips must be edited in the Clip Editor.')
        log.info('project', `splitClipAt rejected linked clip id=${clipId}`)
        return null
      }
      // For warped clips the visible footprint is `nativeDur / ratio`,
      // so the user-visible split position (timeline-time) maps to a
      // source-time offset of `(atMs - clip.startMs) * ratio`. Compute
      // both — `startMs` for the new right-half stays in timeline-time
      // (the visible left edge of the new clip), while `inMs` /
      // `durationMs` must be in source-time for the audio engine.
      const ratio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1
      const effectiveDurMs = clip.durationMs / ratio
      const clipEnd = clip.startMs + effectiveDurMs
      // Need a strict-interior split: a split exactly at either edge
      // would mint a zero-length sibling. 1 ms of slack matches the
      // ms-precision we promised the user.
      if (atMs <= clip.startMs + 1 || atMs >= clipEnd - 1) return null

      const splitOffsetTimelineMs = atMs - clip.startMs
      const splitOffsetSourceMs = splitOffsetTimelineMs * ratio
      const newClipDurationMs = clip.durationMs - splitOffsetSourceMs
      const newClipInMs = clip.inMs + splitOffsetSourceMs
      const newClipStartMs = atMs

      // Shrink original first (atomic three-field write). Left-half
      // source-time duration = `splitOffsetSourceMs`.
      this.trimClip(clipId, clip.startMs, clip.inMs, splitOffsetSourceMs)

      // Mint the right-hand half as a new clip on the same track,
      // sharing peaks + sampleRate + channelCount with the original
      // (cheap — peaks is a shared Float32Array reference). Warp
      // settings carry over so a split warped clip doesn't lose its
      // tempo / pitch state — both halves continue to play in time.
      const track = this.tracks.find((t) => t.id === clip.trackId)
      if (!track) return null
      const newId = crypto.randomUUID()
      const right: Clip = {
        id: newId,
        trackId: clip.trackId,
        libraryItemId: clip.libraryItemId,
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
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        pendingAutoWarp: clip.pendingAutoWarp,
        effectiveDurationMs: clip.effectiveDurationMs,
        effectiveTempoRatio: clip.effectiveTempoRatio,
        effectiveWarpActive: clip.effectiveWarpActive
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
        libraryItemId: clip.libraryItemId,
        positionMs: newClipStartMs,
        inMs: newClipInMs,
        durationMs: newClipDurationMs,
        ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {})
      })
      this.pushTrackGain(track)
      if (clip.name) {
        sendBridge('CLIP_RENAME', { clipId: newId, name: clip.name })
      }
      // Replay warp onto the new clip via the bridge so the backend
      // builds a fresh WarpProcessor on the engine's right-half track.
      // Skip the envelope when warp is off — there's nothing to
      // configure and we'd burn an undo step for no audible effect.
      if (clip.warpEnabled === true) {
        sendBridge('CLIP_SET_WARP', {
          clipId: newId,
          warpEnabled: true,
          warpMode: clip.warpMode,
          tempoRatio: clip.tempoRatio,
          semitones: clip.semitones,
          cents: clip.cents
        })
      }
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
      // Use effective (post-warp) durations everywhere we reason about
      // timeline placement and overlap. `tail.durationMs` is the
      // source-time length; we want the visible footprint.
      const tailEffDur = effectiveClipDurationMs(tail)
      const newStartMs = tail.startMs + tailEffDur
      const clipEffDur = effectiveClipDurationMs(clip)
      // The duplicate must fit immediately after the current tail. We do
      // not search other gaps because repeated Duplicate is an append
      // gesture; if something blocks the chain, tell the user.
      for (const id of track.clipIds) {
        if (id === clipId || id === tail.id) continue
        const c = this.clips[id]
        if (!c) continue
        const cEffDur = effectiveClipDurationMs(c)
        const cEnd = c.startMs + cEffDur
        if (newStartMs < cEnd && newStartMs + clipEffDur > c.startMs) {
          useNotificationsStore().pushError('Not enough space to duplicate clip after the last duplicate.')
          log.info('project', `duplicateClip rejected: source=${clipId} tail=${tail.id} overlaps clip ${id}`)
          return null
        }
      }
      const newId = crypto.randomUUID()
      const copy: Clip = {
        id: newId,
        trackId: clip.trackId,
        libraryItemId: clip.libraryItemId,
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
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        pendingAutoWarp: clip.pendingAutoWarp
      }
      this.clips[newId] = copy
      const insertAt = track.clipIds.indexOf(tail.id)
      if (insertAt >= 0) {
        track.clipIds.splice(insertAt + 1, 0, newId)
      } else {
        track.clipIds.push(newId)
      }
      this.duplicateTailBySource[clipId] = newId
      const clipEnd = copy.startMs + clipEffDur
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd

      sendBridge('CLIP_ADD', {
        trackId: clip.trackId,
        clipId: newId,
        libraryItemId: clip.libraryItemId,
        positionMs: newStartMs,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        ...(clip.colorIndex !== undefined ? { colorIndex: clip.colorIndex } : {})
      })
      this.pushTrackGain(track)
      if (clip.name) {
        sendBridge('CLIP_RENAME', { clipId: newId, name: clip.name })
      }
      // Carry warp settings onto the duplicate via the bridge so the
      // backend builds a fresh WarpProcessor on the new engine clip.
      // Skip when warp is off to avoid burning an undo step on an
      // inaudible no-op.
      if (clip.warpEnabled === true) {
        sendBridge('CLIP_SET_WARP', {
          clipId: newId,
          warpEnabled: true,
          warpMode: clip.warpMode,
          tempoRatio: clip.tempoRatio,
          semitones: clip.semitones,
          cents: clip.cents
        })
      }
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
        libraryItemId: clip.libraryItemId,
        filePath: clip.filePath,
        inMs: clip.inMs,
        durationMs: clip.durationMs,
        colorIndex: clip.colorIndex,
        name: clip.name,
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: clip.tempoRatio,
        semitones: clip.semitones,
        cents: clip.cents,
        effectiveDurationMs: clip.effectiveDurationMs,
        effectiveTempoRatio: clip.effectiveTempoRatio,
        effectiveWarpActive: clip.effectiveWarpActive
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
     * Paste the clipboard clip onto the currently selected track at
     * the playhead. The slot has to be free on the target track —
     * we never overwrite or push another clip. If the slot is taken,
     * the paste is rejected with a toast.
     */
    pasteClipAtPlayhead(positionMs?: number): string | null {
      const cb = this.clipboardClip
      if (!cb) return null
      const targetTrackId = this.selectedTrackId
      if (!targetTrackId) {
        log.warn('project', 'pasteClip: no selected target track')
        useNotificationsStore().pushError("Can't paste — select a target track first.")
        return null
      }
      const track = this.tracks.find((t) => t.id === targetTrackId)
      if (!track) {
        log.warn('project', `pasteClip: target track ${targetTrackId} no longer exists`)
        useNotificationsStore().pushError("Can't paste — target track has been removed.")
        return null
      }
      // Effective duration of the clipboard clip — the visible
      // footprint, which is what targetStartMs + overlap checks
      // operate in. Source-time `durationMs` would over/under-count
      // a warped clip's timeline length.
      const cbEffDur =
        typeof cb.effectiveDurationMs === 'number' && cb.effectiveDurationMs > 0
          ? cb.effectiveDurationMs
          : cb.durationMs

      const targetStartMs = Math.max(0, positionMs ?? 0)
      for (const id of track.clipIds) {
        const c = this.clips[id]
        if (!c) continue
        const cEffDur = effectiveClipDurationMs(c)
        const cEnd = c.startMs + cEffDur
        if (targetStartMs < cEnd && targetStartMs + cbEffDur > c.startMs) {
          useNotificationsStore().pushError('Not enough space to paste clip on this track.')
          log.info(
            'project',
            `pasteClip rejected: target=${targetStartMs} dur=${cbEffDur} overlaps clip ${id} on ${targetTrackId}`
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
        libraryItemId: cb.libraryItemId,
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
        colorIndex: cb.colorIndex,
        name: cb.name,
        warpEnabled: cb.warpEnabled,
        warpMode: cb.warpMode,
        tempoRatio: cb.tempoRatio,
        semitones: cb.semitones,
        cents: cb.cents,
        effectiveDurationMs: cb.effectiveDurationMs,
        effectiveTempoRatio: cb.effectiveTempoRatio,
        effectiveWarpActive: cb.effectiveWarpActive
      }
      const peakSource = Object.values(this.clips).find(
        (c) => c.libraryItemId === cb.libraryItemId && c.peaks.length > 0
      )
      if (peakSource) {
        placeholder.peaks = peakSource.peaks
        placeholder.sampleRate = peakSource.sampleRate
      }
      this.clips[newId] = placeholder
      track.clipIds.push(newId)
      const clipEnd = startMs + cbEffDur
      if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
      this.selectedClipId = newId
      this.peaksRevision++

      sendBridge('CLIP_ADD', {
        trackId: track.id,
        clipId: newId,
        libraryItemId: cb.libraryItemId,
        positionMs: startMs,
        inMs: cb.inMs,
        durationMs: cb.durationMs,
        ...(cb.colorIndex !== undefined ? { colorIndex: cb.colorIndex } : {})
      })
      this.pushTrackGain(track)
      if (cb.name) {
        sendBridge('CLIP_RENAME', { clipId: newId, name: cb.name })
      }
      // Replay warp onto the pasted clip's engine voice — same as
      // duplicate / split. Backend builds a fresh WarpProcessor.
      if (cb.warpEnabled === true) {
        sendBridge('CLIP_SET_WARP', {
          clipId: newId,
          warpEnabled: true,
          warpMode: cb.warpMode,
          tempoRatio: cb.tempoRatio,
          semitones: cb.semitones,
          cents: cb.cents
        })
      }
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

    /** Re-point an unresolved library item at a replacement source
     *  file. Every clip that references the library item picks up the
     *  new file automatically — the user relinks once per library
     *  item, not once per clip. */
    relinkLibraryItem(itemId: string, filePath: string): void {
      sendBridge('LIBRARY_ITEM_RELINK', { itemId, filePath })
      log.info('project', `relinkLibraryItem id=${itemId} -> ${filePath}`)
    },

    /**
     * Set or clear a clip's user-facing display name override. Blank
     * input clears the override and the clip falls back to its library
     * item title / filename. Sent over the bridge as `CLIP_RENAME` so
     * the rename persists with the project.
     */
    renameClip(clipId: string, name: string): boolean {
      const clip = this.clips[clipId]
      if (!clip) return false
      const trimmed = name.trim()
      const nextName = trimmed.length > 0 ? trimmed : undefined
      if (clip.name === nextName) return false
      clip.name = nextName
      // Bump the redraw counter so the timeline repaints the clip's
      // header label without waiting for the next position/peak change.
      this.peaksRevision++
      sendBridge('CLIP_RENAME', { clipId, name: nextName ?? '' })
      log.info('project', `renameClip id=${clipId} -> ${nextName ?? '<cleared>'}`)
      return true
    },

    /** Promote the selected timeline clip window into a reusable library saved clip. */
    saveClipToLibrary(clipId: string): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      const itemId = useLibraryStore().addSavedClipFromTimelineClip(clip)
      if (itemId) {
        // Rebind the originating timeline clip to the new saved-clip
        // so the project file records the correct parent relationship.
        // Without this the clip keeps pointing at the underlying
        // audio-file source, and the saved-clip's "Used on" view
        // would never see it.
        if (clip.libraryItemId !== itemId) {
          clip.libraryItemId = itemId
          sendBridge('CLIP_REBIND', { clipId, libraryItemId: itemId })
        }
        log.info('project', `saveClipToLibrary clip=${clipId} item=${itemId}`)
      }
      return itemId
    },

    async saveClipAsSample(clipId: string): Promise<void> {
      const clip = this.clips[clipId]
      if (!clip) return
      const itemId = `sample-${crypto.randomUUID()}`
      sendBridge('CLIP_SAVE_AS_SAMPLE', {
        clipId,
        itemId,
        sampleName: clip.name?.trim() || fileStem(clip.fileName),
        outputDir: await defaultSamplesDir(this.currentFilePath)
      })
      useNotificationsStore().pushInfo('Saving sample…')
    },

    /**
     * Break the bond between a timeline clip and its parent saved-clip,
     * making the clip independent. The clip's current trim window is
     * preserved exactly (we just rebind libraryItemId to the saved-clip's
     * underlying audio-file source). No-op when the clip is already
     * independent (libraryItemId points at an audio-file).
     *
     * Used by:
     *   - Right-click → "Unlink from library" on a linked clip.
     *   - The edge-drag trim path (auto-unlinks before the trim so
     *     the edit doesn't propagate to linked siblings).
     *   - Cascade from `libraryStore.removeItem` when a saved-clip is
     *     deleted (each linked sibling is unlinked here first).
     */
    unlinkClipFromLibrary(clipId: string): boolean {
      const clip = this.clips[clipId]
      if (!clip) return false
      const library = useLibraryStore()
      const parent = library.byId[clip.libraryItemId]
      if (!parent || parent.kind !== 'saved-clip') return false
      const fallbackParentId = parent.derivedFrom?.sourceItemId
      if (!fallbackParentId) return false
      clip.libraryItemId = fallbackParentId
      sendBridge('CLIP_REBIND', { clipId, libraryItemId: fallbackParentId })
      // Bump the redraw revision so the timeline picks up the new
      // library binding immediately — the chain-link badge depends on
      // `clip.libraryItemId` resolved against the library, but the
      // timeline's watchers key on track/clip counts and peaksRevision,
      // not on per-clip libraryItemId. Without this nudge the unlinked
      // clip still shows the linked-icon until the next unrelated redraw.
      this.peaksRevision++
      log.info('project', `unlinkClipFromLibrary clip=${clipId} -> source=${fallbackParentId}`)
      return true
    },

    /**
     * Mutate a clip's warp + pitch settings locally and push them to
     * the backend. Every field is optional; only the fields supplied
     * are applied. Pass `tempoRatio: null` (not `undefined`) to clear
     * the pinned ratio so the clip reverts to following the project
     * BPM live. The bridge envelope coalesces within 500 ms by
     * (clipId, type) so dragging a slider commits a single undo step.
     */
    setClipWarp(
      clipId: string,
      patch: {
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        /** `null` clears the pinned override; `number` pins it. */
        tempoRatio?: number | null
        semitones?: number
        cents?: number
        pendingAutoWarp?: boolean
        effectiveDurationMs?: number
        effectiveTempoRatio?: number
        effectiveWarpActive?: boolean
      },
      opts?: { localOnly?: boolean }
    ): void {
      const clip = this.clips[clipId]
      if (!clip) return
      if (patch.warpEnabled !== undefined) clip.warpEnabled = patch.warpEnabled
      if (patch.warpMode !== undefined) clip.warpMode = patch.warpMode
      if (patch.tempoRatio !== undefined) {
        clip.tempoRatio = patch.tempoRatio === null ? undefined : patch.tempoRatio
      }
      if (patch.semitones !== undefined) clip.semitones = patch.semitones
      if (patch.cents !== undefined) clip.cents = patch.cents
      if (patch.pendingAutoWarp !== undefined) {
        clip.pendingAutoWarp = patch.pendingAutoWarp ? true : undefined
      }
      if (patch.effectiveDurationMs !== undefined) clip.effectiveDurationMs = patch.effectiveDurationMs
      if (patch.effectiveTempoRatio !== undefined) clip.effectiveTempoRatio = patch.effectiveTempoRatio
      if (patch.effectiveWarpActive !== undefined) clip.effectiveWarpActive = patch.effectiveWarpActive
      // Any explicit warp-field edit clears the "waiting for analysis"
      // flag so a late-arriving LIBRARY_ITEM_ANALYSIS can't override
      // the latest state.
      if (
        patch.warpEnabled !== undefined ||
        patch.warpMode !== undefined ||
        patch.tempoRatio !== undefined ||
        patch.semitones !== undefined ||
        patch.cents !== undefined
      ) {
        clip.pendingAutoWarp = undefined
      }
      // Force a timeline redraw so any clip-header badge or
      // effective-duration UI catches up.
      this.peaksRevision++
      if (!opts?.localOnly && patch.warpEnabled === true) {
        useLibraryStore().markItemWarping(clip.libraryItemId)
      }
      if (!opts?.localOnly) {
        sendBridge('CLIP_SET_WARP', {
          clipId,
          warpEnabled: patch.warpEnabled,
          warpMode: patch.warpMode,
          // The wire protocol uses absence to mean "don't change" and an
          // explicit `null` to mean "clear the override". The default
          // payload guard inserts JSON `null` for `null` so the backend
          // sees the clear signal.
          tempoRatio: patch.tempoRatio === undefined ? undefined : patch.tempoRatio,
          semitones: patch.semitones,
          cents: patch.cents,
          pendingAutoWarp: patch.pendingAutoWarp
        })
      }
    },

    /**
     * True if placing a clip of `durationMs` length on `trackId` starting at
     * `startMs` would overlap any existing clip on that track. Used by the
     * library drag-drop flow to reject drops onto occupied space.
     *
     * `durationMs` is the **timeline footprint** of the prospective new
     * clip — i.e. the effective (post-warp) length the caller expects
     * to see on the ruler. Existing clips on the track are compared
     * against their own effective durations so a warped clip's audible
     * footprint is what collision-checks against. Un-warped clips
     * fall through unchanged because `clipEffectiveDurationMs` is the
     * native value in that case.
     */
    wouldClipOverlap(trackId: string, startMs: number, durationMs: number): boolean {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return false
      const newStart = Math.max(0, startMs)
      const newEnd = newStart + durationMs
      for (const otherId of track.clipIds) {
        const other = this.clips[otherId]
        if (!other) continue
        const otherEffDur = effectiveClipDurationMs(other)
        const otherEnd = other.startMs + otherEffDur
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
        id: string
        filePath: string
        fileName: string
        durationMs: number
        sampleRate: number
        channelCount: number
        peaks: Float32Array
        peaksPerSecond?: number
        /** Optional backend-loadable path; falls back to `filePath`. */
        playbackFilePath?: string
        kind?: LibraryItem['kind']
        name?: string
        derivedFrom?: LibraryItem['derivedFrom']
        /** Source BPM for auto-warp (audio-file items + variable-tempo
         *  files surface their median here). */
        bpm?: number
        /** True when the source's tempo wasn't stable enough for a
         *  global ratio to be safe. Auto-warp skips these. */
        variableTempo?: boolean
        /** Saved-clip default warp settings (copy-on-drop). */
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number
        semitones?: number
        cents?: number
      },
      startMs: number
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null
      const snapped = Math.max(0, Math.floor(startMs))
      const clipInMs =
        libraryItem.kind === 'saved-clip' ? Math.max(0, libraryItem.derivedFrom?.inMs ?? 0) : 0
      const clipDurationMs =
        libraryItem.kind === 'saved-clip'
          ? Math.max(0, libraryItem.derivedFrom?.durationMs ?? libraryItem.durationMs)
          : libraryItem.durationMs
      // Effective timeline footprint of the prospective new clip. Auto-
      // warp will engage post-drop for non-variable-tempo sources with
      // known BPMs IF the user's auto-warp preference is on AND the
      // project already has another clip — the first clip on a fresh
      // project seeds the project BPM instead of warping (see
      // `applyDropTimeWarp`). Saved clips carry explicit warp
      // defaults regardless. Reflect that in the collision check so
      // an auto-warped clip doesn't get rejected for an overlap that
      // won't exist once warp lands.
      const projectBpm = useTransportStore().bpm
      const autoWarpPref = useUiStore().matchProjectTempoOnDrop
      const projectHasOtherClips = Object.keys(this.clips).length > 0
      const willAutoWarp =
        libraryItem.warpEnabled === true ||
        (autoWarpPref &&
          projectHasOtherClips &&
          libraryItem.kind !== 'saved-clip' &&
          libraryItem.variableTempo !== true &&
          typeof libraryItem.bpm === 'number' && libraryItem.bpm > 0 &&
          typeof projectBpm === 'number' && projectBpm > 0)
      let effectiveClipDurationMs = clipDurationMs
      if (willAutoWarp) {
        const pinned = libraryItem.tempoRatio
        const ratio = typeof pinned === 'number' && pinned > 0
          ? pinned
          : (typeof libraryItem.bpm === 'number' && libraryItem.bpm > 0 && projectBpm > 0
              ? projectBpm / libraryItem.bpm
              : 1)
        if (ratio > 0 && Math.abs(ratio - 1) > 1e-4) {
          effectiveClipDurationMs = clipDurationMs / ratio
        }
      }
      if (this.wouldClipOverlap(trackId, snapped, effectiveClipDurationMs)) return null

      const inheritedName = libraryItem.name?.trim() || ''
      const clipId = this.addClipToTrack(
        trackId,
        {
          libraryItemId: libraryItem.id,
          filePath: libraryItem.filePath,
          fileName: inheritedName || libraryItem.fileName,
          durationMs: clipDurationMs,
          sampleRate: libraryItem.sampleRate,
          channelCount: libraryItem.channelCount,
          peaks: libraryItem.peaks,
          peaksPerSecond: libraryItem.peaksPerSecond,
          playbackFilePath: libraryItem.playbackFilePath,
          inMs: clipInMs
        },
        snapped
      )
      if (!clipId) return null

      sendBridge('CLIP_ADD', {
        trackId,
        clipId,
        libraryItemId: libraryItem.id,
        positionMs: snapped,
        ...(clipInMs > 0 || libraryItem.kind === 'saved-clip' ? { inMs: clipInMs } : {}),
        ...(libraryItem.kind === 'saved-clip' ? { durationMs: clipDurationMs } : {})
      })
      if (inheritedName) {
        const newClip = this.clips[clipId]
        if (newClip) newClip.name = inheritedName
        sendBridge('CLIP_RENAME', { clipId, name: inheritedName })
      }

      // Warp on drop. Two-stage policy:
      //   1. Saved-clip tile → copy the saved clip's warp settings as
      //      the new clip's defaults (copy-on-drop, not live link).
      //   2. Audio-file tile (or saved clip with no inherited warp) →
      //      auto-warp to project BPM iff both BPMs are known and the
      //      source isn't variable-tempo. If the source BPM hasn't been
      //      analysed yet, leave warp off but mark `pendingAutoWarp`
      //      so the backend's LIBRARY_ITEM_ANALYSIS handler can flip
      //      it on once detection lands.
      this.applyDropTimeWarp(clipId, libraryItem)

      this.pushTrackGain(track)
      log.info('project', `addClipFromLibrary track=${trackId} clip=${clipId} pos=${snapped}ms`)
      return clipId
    },

    /**
     * Decide a new clip's warp settings at drop time and push them to
     * the backend if any field is non-default. Split out of
     * `addClipFromLibrary` so the policy lives in one place (and so a
     * future paste / duplicate code path can reuse it).
     */
    applyDropTimeWarp(
      clipId: string,
      src: {
        kind?: LibraryItem['kind']
        bpm?: number
        variableTempo?: boolean
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number
        semitones?: number
        cents?: number
      }
    ): void {
      log.info(
        'warp',
        `applyDropTimeWarp clip=${clipId} kind=${src.kind ?? 'audio'} ` +
          `srcBpm=${src.bpm ?? 'undef'} variableTempo=${src.variableTempo ?? false} ` +
          `inheritedWarpEnabled=${src.warpEnabled ?? 'undef'} ` +
          `inheritedTempoRatio=${src.tempoRatio ?? 'undef'}`
      )
      // Saved-clip inheritance wins — these are the user's deliberate
      // defaults captured at save-to-library time. Always applied even
      // when the auto-warp pref is off, because they're explicit
      // choices the user made when saving the clip, not project-tempo
      // auto-match.
      if (src.kind === 'saved-clip' && (
        src.warpEnabled !== undefined ||
        src.warpMode !== undefined ||
        src.tempoRatio !== undefined ||
        src.semitones !== undefined ||
        src.cents !== undefined
      )) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → saved-clip inheritance branch`)
        this.setClipWarp(clipId, {
          warpEnabled: src.warpEnabled,
          warpMode: src.warpMode,
          tempoRatio: src.tempoRatio,
          semitones: src.semitones,
          cents: src.cents
        })
        return
      }
      // Project-tempo auto-match is gated by the user preference. When
      // off, the clip drops at native rate and the user can still
      // engage warp manually via right-click -> Warp.
      const ui = useUiStore()
      if (!ui.matchProjectTempoOnDrop) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → skip (matchProjectTempoOnDrop pref OFF)`)
        return
      }
      // First clip on a fresh project: skip auto-warp entirely. The
      // backend's `maybeSeedProjectBpmFor` will seed the project BPM
      // to this clip's source BPM once analysis completes, so warping
      // it to "match project BPM" would end up at ratio 1 anyway —
      // and worse, in the analysis-known-at-drop-time case we'd warp
      // to the default-100 BPM that's about to be overwritten by the
      // seed. Saved clips with explicit warp defaults already
      // returned above so they still drop with their saved warp.
      const otherClipExists = Object.values(this.clips).some((c) => c.id !== clipId)
      if (!otherClipExists) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → skip (first clip on project)`)
        return
      }
      // Need a stable source BPM (variable-tempo skipped — its median
      // is misleading at most positions in the clip) and a project
      // BPM to target.
      const projectBpm = useTransportStore().bpm
      if (src.variableTempo === true || typeof src.bpm !== 'number' || src.bpm <= 0) {
        // Source BPM unknown today — mark the clip as waiting on
        // analysis. The backend's analysis-done handler can flip warp
        // on later if the user hasn't already opted out.
        if (src.kind !== 'saved-clip' && src.variableTempo !== true) {
          log.info(
            'warp',
            `applyDropTimeWarp clip=${clipId} → pendingAutoWarp (source BPM not yet known)`
          )
          this.setClipWarp(clipId, { pendingAutoWarp: true })
        } else {
          log.info(
            'warp',
            `applyDropTimeWarp clip=${clipId} → skip (variableTempo or no BPM, not pending)`
          )
        }
        return
      }
      if (typeof projectBpm !== 'number' || projectBpm <= 0) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (project BPM unknown: ${projectBpm})`
        )
        return
      }
      const ratio = projectBpm / src.bpm
      // Skip when the ratio is effectively 1 — no audible difference
      // and no point burning an undo step.
      if (Math.abs(ratio - 1) < 1e-3) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (ratio ≈ 1: project=${projectBpm} src=${src.bpm})`
        )
        return
      }
      log.info(
        'warp',
        `applyDropTimeWarp clip=${clipId} → ENGAGE warp (project=${projectBpm} src=${src.bpm} ratio=${ratio.toFixed(4)})`
      )
      this.setClipWarp(clipId, {
        warpEnabled: true,
        warpMode: 'rhythmic',
        // Leave `tempoRatio` undefined so the clip continues to follow
        // project BPM changes — pinning is a user-driven choice via
        // the Warp dialog.
      })
    },

    /**
     * Set the project's visible timeline length (ms). Updates every track's
     * `lengthMs`, but never below the end of that track's longest clip — so
     * the user can shrink the project but never clip audio off-screen.
     * No-op when there are no tracks.
     */
    setProjectLengthMs(lengthMs: number): void {
      if (this.tracks.length === 0) return
      const target = Math.max(this.longestClipEndMs, Math.max(0, Math.floor(lengthMs)))
      for (const track of this.tracks) {
        let minLength = 0
        for (const clipId of track.clipIds) {
          const clip = this.clips[clipId]
          if (!clip) continue
          // Use the clip's effective (post-warp) timeline footprint so
          // a shorter warped clip doesn't artificially keep the track
          // longer than necessary, and a stretched warped clip can't
          // be cropped under its audible end.
          const effDur = effectiveClipDurationMs(clip)
          const end = clip.startMs + effDur
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
     * Set a track's volume (linear gain, 0.0–1.5; 1.0 is unity, the
     * slider's mid-point) and push the new effective gain to the
     * backend. Mute / solo still override volume to silence.
     *
     * Use this for *commits* (e.g. the slider's `@change` event). For the
     * live drag (every `@input`) use `setTrackVolumeLocal` so we don't
     * flood the bridge with one envelope per pixel of slider movement.
     */
    setTrackVolume(trackId: string, volume: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
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
      t.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, volume))
    },

    /**
     * Mutate a track's `heightPx` locally without pushing to the
     * backend — used by the drag handle's `pointermove` so the row
     * resizes smoothly under the cursor. The committed value is sent
     * once on `pointerup` via `setTrackHeight` so the bridge isn't
     * flooded with one envelope per frame and the undo manager
     * captures a single coalesced edit per drag.
     */
    setTrackHeightLocal(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
    },

    /**
     * Commit a track's `heightPx` to the backend so it's persisted with
     * the project file and joins the undo history. Sent on
     * `pointerup` at the end of a resize drag; the backend acks via a
     * fresh `PROJECT_STATE` so any clamp the engine applies surfaces
     * back to the renderer.
     */
    setTrackHeight(trackId: string, heightPx: number): void {
      const t = this.tracks.find((x) => x.id === trackId)
      if (!t) return
      t.heightPx = heightPx
      sendBridge('TRACK_SET_HEIGHT', { trackId, heightPx })
    },

    /**
     * Move `trackId` to a new 0-based position in the project's track
     * order. Sent once on drop after the user drags a track header.
     * The mutation is optimistic (the local array is reordered before
     * the bridge ack) so the timeline repaints immediately; the
     * backend stores the new order in its ValueTree with undo support
     * and broadcasts a soft-replace PROJECT_STATE after EDIT_UNDO /
     * EDIT_REDO so the renderer can re-sort to match.
     */
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
    setClipPeaks(clipId: string, peaks: Float32Array, sampleRate: number, peaksPerSecond?: number): void {
      const clip = this.clips[clipId]
      if (!clip) return
      clip.peaks = peaks
      if (typeof peaksPerSecond === 'number' && peaksPerSecond > 0) clip.peaksPerSecond = peaksPerSecond
      if (sampleRate > 0) clip.sampleRate = sampleRate
      // Tick the global peaks revision so consumers redraw. A single
      // counter is much cheaper than a `deep: true` watch on `clips`,
      // and the redraw cost is amortised across however many clips
      // get their peaks in one PROJECT_STATE rehydrate cycle.
      this.peaksRevision++
      // Also refresh the matching library item's peaks (and sample
      // rate) so the library card shows the waveform after a reload.
      // Prefer the whole-file source row because saved clips can share
      // the same filePath with their parent.
      const lib = useLibraryStore()
      const item =
        lib.items.find((i) => i.kind === 'audio-file' && i.filePath === clip.filePath) ??
        lib.items.find((i) => i.filePath === clip.filePath)
      if (item && item.peaks.length === 0) {
        lib.setItemPeaks(item.id, peaks, sampleRate, peaksPerSecond)
      }
      log.debug('project', `setClipPeaks id=${clipId} peaks=${peaks.length / 2} sr=${sampleRate} pps=${clip.peaksPerSecond ?? 'undef'}`)
    },

    applyProjectStateSnapshot(snapshot: ProjectStatePayload): void {
      log.info(
        'project',
        `applyProjectStateSnapshot tracks=${snapshot.tracks.length} clips=${snapshot.tracks.reduce((n, t) => n + t.clips.length, 0)} reset=${snapshot.reset === true} path=${snapshot.filePath ?? 'null'} name=${snapshot.name}`
      )
      // Stashed length applied at the end, after tracks have been
      // reconciled (the setter writes to each track's lengthMs).
      let pendingProjectLengthMs: number | null = null
      // Soft-replace is the authoritative-reconcile variant used by
      // Undo / Redo: replace tracks/clips/library/markers wholesale
      // (so things that disappeared actually disappear) WITHOUT
      // marking clean, rotating projectId, or clearing the clipboard
      // and selection. The backend explicitly resends PROJECT_DIRTY
      // with the correct dirty state right after this envelope so the
      // title-bar indicator stays accurate.
      const isSoftReplace = snapshot.softReplace === true
      // Adopt the project identity fields up front so any code that reads
      // them during the snapshot apply (e.g. the title bar) sees the
      // post-load values. A fresh snapshot is by definition clean — any
      // mutation made AFTER it lands will flip dirty back to true via
      // a follow-up PROJECT_DIRTY envelope.
      const previousFilePath = this.currentFilePath
      this.currentFilePath = snapshot.filePath
      this.projectName = snapshot.name?.trim() ? snapshot.name : DEFAULT_PROJECT_NAME
      if (!isSoftReplace) {
        this.isDirty = false
      }
      // Bucket transition for autosave. We rotate the project id on
      // any snapshot that *replaces* the project — Load / New (which
      // carry `reset=true`) AND Save As (which broadcasts a follow-up
      // `reset=false` PROJECT_STATE with a new `filePath`, because
      // the in-memory ValueTree itself didn't change — only the
      // backing file did). Bucket cleanup for the prior id is run
      // by the `previousProjectId` watcher in `lib/autosave.ts`.
      const pathChanged = snapshot.filePath !== previousFilePath
      const shouldRotateId = (snapshot.reset === true || pathChanged) && !isSoftReplace
      if (shouldRotateId) {
        this.previousProjectId = this.projectId
        if (snapshot.filePath) {
          // Derive a stable id from the absolute path. The derivation
          // is async (subtle.digest); assign provisionally to null so
          // the autosave manager's start-condition treats the project
          // as "not yet ready" until the id resolves.
          const targetPath = snapshot.filePath
          this.projectId = null
          void deriveProjectIdFromPath(targetPath).then((id) => {
            // Only adopt the id if the snapshot is still the current
            // project — a follow-up Load could have raced this.
            if (this.currentFilePath === targetPath) this.projectId = id
          })
        } else {
          this.projectId = this.pendingRecoveredProjectId ?? freshUntitledProjectId()
        }
      }
      this.pendingRecoveredProjectId = null
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
      //
      // Undo / Redo sets `softReplace=true`: the same wholesale-replace
      // semantics for tracks/clips/markers/library, but preserves the
      // clipboard and selection (which aren't ValueTree state).
      if (snapshot.reset === true || isSoftReplace) {
        this.tracks = []
        this.clips = {}
        this.markers = []
        if (!isSoftReplace) {
          this.selectedClipId = null
          this.selectedTrackId = null
          this.clipboardClip = null
        }
        this.duplicateTailBySource = {}
        this.peaksRevision++
        library.clear()
      }

      this.markers = Array.isArray(snapshot.markers)
        ? snapshot.markers
            .filter((marker) => marker.positionMs >= 0)
            .map((marker) => ({ id: marker.id, positionMs: marker.positionMs }))
            .sort((a, b) => a.positionMs - b.positionMs)
        : []

      // Hydrate persisted library entries BEFORE the clip-driven path
      // below runs — clips that point at the same filePath will then
      // see the existing item and skip the duplicate-add branch. We
      // pass `fromSnapshot: true` so the libraryStore doesn't echo
      // these adds back as LIBRARY_ADD envelopes.
      if (snapshot.library) {
        for (const item of snapshot.library) {
          if (library.items.some((i) => i.id === item.id)) continue
          const libId = library.addItem({
            id: item.id,
            kind: item.kind ?? 'audio-file',
            name: item.name,
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
            derivedFrom:
              item.kind === 'saved-clip'
                ? {
                    sourceItemId: item.sourceItemId,
                    sourceClipId: item.sourceClipId,
                    inMs: Math.max(0, item.sourceInMs ?? 0),
                    durationMs: Math.max(0, item.sourceDurationMs ?? item.durationMs ?? 0)
                  }
                : undefined,
            collapsed: item.collapsed === true ? true : undefined,
            warpEnabled: item.kind === 'saved-clip' && typeof item.warpEnabled === 'boolean'
              ? item.warpEnabled
              : undefined,
            warpMode: item.kind === 'saved-clip' ? item.warpMode : undefined,
            tempoRatio: item.kind === 'saved-clip' && typeof item.tempoRatio === 'number'
              ? item.tempoRatio
              : undefined,
            semitones: item.kind === 'saved-clip' && typeof item.semitones === 'number'
              ? item.semitones
              : undefined,
            cents: item.kind === 'saved-clip' && typeof item.cents === 'number'
              ? item.cents
              : undefined,
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
          if ((item.kind ?? 'audio-file') === 'audio-file') {
            void refreshLibraryItemMedia(libId, item.filePath)
          }
        }
        for (const item of library.items) {
          if (item.kind !== 'saved-clip' || item.bpm !== undefined) continue
          const sourceId = item.derivedFrom?.sourceItemId
          if (!sourceId) continue
          const source = library.byId[sourceId]
          if (!source || typeof source.bpm !== 'number' || source.bpm <= 0) continue
          library.setItemAnalysis(
            item.id,
            source.bpm,
            source.beatAnchorSec ?? source.beats?.[0] ?? 0,
            source.beats ?? [],
            source.variableTempo === true,
            source.decodedCacheFilePath
          )
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
            volume: Math.min(MAX_TRACK_VOLUME, Math.max(0, t.gain)),
            colorIndex: index % TRACK_PALETTE.length,
            lengthMs: DEFAULT_TRACK_LENGTH_MS,
            heightPx: typeof t.heightPx === 'number' && t.heightPx > 0 ? t.heightPx : undefined
          }
          this.tracks.push(track)
        } else {
          const persistedName = t.name?.trim()
          if (persistedName && persistedName.length > 0) {
            track.name = persistedName
          }
          if (typeof t.heightPx === 'number' && t.heightPx > 0) {
            track.heightPx = t.heightPx
          }
        }
        for (const c of t.clips) {
          const offset = Math.max(0, c.offsetMs)
          // Resolve the clip's source via its library item id (the
          // single source of truth). The library was hydrated earlier
          // in this snapshot apply so the lookup should succeed; if a
          // clip somehow points at an unknown library item we skip it
          // rather than minting a phantom library entry.
          const libItem = library.byId[c.libraryItemId]
          if (!libItem) {
            log.warn(
              'project',
              `skip clip ${c.id} — unknown libraryItemId=${c.libraryItemId}`
            )
            continue
          }
          const clipFilePath = libItem.filePath
          const existing = this.clips[c.id]
          if (existing) {
            existing.startMs = offset
            existing.inMs = Math.max(0, c.inMs ?? 0)
            existing.durationMs = Math.max(0, c.durationMs)
            existing.unresolved = c.unresolved === true
            existing.colorIndex = typeof c.colorIndex === 'number' ? c.colorIndex : undefined
            existing.name = typeof c.name === 'string' && c.name.trim().length > 0 ? c.name : undefined
            existing.warpEnabled = typeof c.warpEnabled === 'boolean' ? c.warpEnabled : undefined
            existing.warpMode = c.warpMode
            existing.tempoRatio = typeof c.tempoRatio === 'number' ? c.tempoRatio : undefined
            existing.semitones = typeof c.semitones === 'number' ? c.semitones : undefined
            existing.cents = typeof c.cents === 'number' ? c.cents : undefined
            existing.effectiveDurationMs =
              typeof c.effectiveDurationMs === 'number' ? c.effectiveDurationMs : undefined
            existing.effectiveTempoRatio =
              typeof c.effectiveTempoRatio === 'number' ? c.effectiveTempoRatio : undefined
            existing.effectiveWarpActive =
              typeof c.effectiveWarpActive === 'boolean' ? c.effectiveWarpActive : undefined
            existing.pendingAutoWarp =
              c.pendingAutoWarp === true && existing.warpEnabled !== true ? true : undefined
            if (existing.peaks.length === 0) clipsNeedingPeaks.push(c.id)
            continue
          }
          // Reconstruct a placeholder clip the renderer can draw at the
          // correct timeline position and width. Waveform peaks are
          // requested separately below.
          const fileName = filePathToDisplayName(clipFilePath)
          const placeholder: Clip = {
            id: c.id,
            trackId: t.id,
            libraryItemId: c.libraryItemId,
            filePath: clipFilePath,
            playbackFilePath: libItem.playbackFilePath,
            fileName,
            startMs: offset,
            inMs: Math.max(0, c.inMs ?? 0),
            durationMs: Math.max(0, c.durationMs),
            sampleRate: libItem.sampleRate,
            channelCount: libItem.channelCount,
            peaks: libItem.peaks.length > 0 ? libItem.peaks : new Float32Array(0),
            unresolved: c.unresolved === true,
            colorIndex: typeof c.colorIndex === 'number' ? c.colorIndex : undefined,
            name: typeof c.name === 'string' && c.name.trim().length > 0 ? c.name : undefined,
            warpEnabled: typeof c.warpEnabled === 'boolean' ? c.warpEnabled : undefined,
            warpMode: c.warpMode,
            tempoRatio: typeof c.tempoRatio === 'number' ? c.tempoRatio : undefined,
            semitones: typeof c.semitones === 'number' ? c.semitones : undefined,
            cents: typeof c.cents === 'number' ? c.cents : undefined,
            effectiveDurationMs:
              typeof c.effectiveDurationMs === 'number' ? c.effectiveDurationMs : undefined,
            effectiveTempoRatio:
              typeof c.effectiveTempoRatio === 'number' ? c.effectiveTempoRatio : undefined,
            effectiveWarpActive:
              typeof c.effectiveWarpActive === 'boolean' ? c.effectiveWarpActive : undefined,
            pendingAutoWarp:
              c.pendingAutoWarp === true && c.warpEnabled !== true ? true : undefined
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
      // Reorder `this.tracks` to match the snapshot's track order.
      // The backend is authoritative on track ordering; without this
      // step a TRACK_REORDER undo (which arrives as a softReplace
      // PROJECT_STATE) wouldn't actually re-shuffle the renderer's
      // array. Locally-known tracks the snapshot doesn't mention stay
      // appended at the end so an optimistic TRACK_ADD that hasn't
      // round-tripped yet doesn't get lost.
      if (snapshot.tracks.length > 0) {
        const indexOf = new Map<string, number>()
        for (let i = 0; i < snapshot.tracks.length; i++) {
          const id = snapshot.tracks[i]?.id
          if (id) indexOf.set(id, i)
        }
        const SENTINEL = Number.MAX_SAFE_INTEGER
        this.tracks.sort((a, b) => {
          const ai = indexOf.has(a.id) ? indexOf.get(a.id)! : SENTINEL
          const bi = indexOf.has(b.id) ? indexOf.get(b.id)! : SENTINEL
          return ai - bi
        })
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

      // Migration: rebind any timeline clip whose (libraryItemId,
      // inMs, durationMs) is an exact audio-equivalent match to an
      // existing saved-clip's (sourceItemId, inMs, durationMs). Fixes
      // projects created before "Save clip to library" rebound the
      // originating clip — without this, those clips stay linked to
      // the source audio-file and the saved-clip's "Used on" view is
      // empty. Saved-clip dedupe upstream guarantees at most one
      // saved-clip per window so the match is unambiguous.
      if (snapshot.reset === true || isSoftReplace) {
        for (const clipId in this.clips) {
          const clip = this.clips[clipId]
          if (!clip) continue
          const candidate = library.items.find(
            (i) =>
              i.kind === 'saved-clip' &&
              i.derivedFrom?.sourceItemId === clip.libraryItemId &&
              Math.abs((i.derivedFrom?.inMs ?? 0) - clip.inMs) < 0.5 &&
              Math.abs((i.derivedFrom?.durationMs ?? 0) - clip.durationMs) < 0.5
          )
          if (candidate && candidate.id !== clip.libraryItemId) {
            log.info(
              'project',
              `migrate clip ${clipId} libraryItemId=${clip.libraryItemId} -> ${candidate.id} (saved-clip window match)`
            )
            clip.libraryItemId = candidate.id
            sendBridge('CLIP_REBIND', { clipId, libraryItemId: candidate.id })
          }
        }
      }
      if (pendingRecoveryLoadTimeout) {
        clearTimeout(pendingRecoveryLoadTimeout)
        pendingRecoveryLoadTimeout = null
      }
      if (pendingRecoveryLoadResolver) {
        pendingRecoveryLoadResolver({ ok: true })
        pendingRecoveryLoadResolver = null
      }
    },

    // ─── Project file lifecycle (Phase 3) ──────────────────────────────────

    /** Send PROJECT_NEW; backend wipes its state and broadcasts a fresh reset snapshot. */
    requestNewProject(): void {
      log.info('project', 'requestNewProject')
      sendBridge('PROJECT_NEW')
    },

    /** Apply an inbound `EDIT_UNDO_STATE` envelope. Mirrors the backend
     *  `juce::UndoManager` head so the Edit menu's Undo / Redo items
     *  reflect the current can-undo / can-redo state. */
    applyEditUndoState(payload: { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string }): void {
      this.canUndo = payload.canUndo
      this.canRedo = payload.canRedo
      this.undoLabel = payload.canUndo && payload.undoLabel ? payload.undoLabel : null
      this.redoLabel = payload.canRedo && payload.redoLabel ? payload.redoLabel : null
    },

    /** Send EDIT_UNDO; backend reverts the most recent undoable
     *  transaction and rebroadcasts the project state. No-op locally if
     *  `canUndo` is false — the backend will also no-op. */
    requestUndo(): void {
      log.info('project', 'requestUndo')
      sendBridge('EDIT_UNDO')
    },

    /** Send EDIT_REDO; backend re-applies the most recently-undone
     *  transaction and rebroadcasts the project state. */
    requestRedo(): void {
      log.info('project', 'requestRedo')
      sendBridge('EDIT_REDO')
    },

    addMarkerAt(positionMs: number): boolean {
      const safePositionMs = Math.max(0, Math.floor(positionMs))
      const existing = this.markers.find((marker) => Math.abs(marker.positionMs - safePositionMs) < 1)
      if (existing) return false

      const marker: Marker = {
        id: crypto.randomUUID(),
        positionMs: safePositionMs
      }
      this.markers.push(marker)
      this.markers.sort((a, b) => a.positionMs - b.positionMs)

      const sent = sendBridge('PROJECT_MARKER_ADD', {
        markerId: marker.id,
        positionMs: marker.positionMs
      })
      if (!sent) {
        useNotificationsStore().pushError('Marker was added locally, but the backend is not connected.')
      }
      log.info('project', `addMarkerAt id=${marker.id} position=${marker.positionMs}`)
      return true
    },

    toggleMarkerAt(positionMs: number): boolean {
      const safePositionMs = Math.max(0, Math.round(positionMs))
      const existing = this.markers.find((marker) => Math.abs(marker.positionMs - safePositionMs) < 1)
      if (existing) return this.removeMarker(existing.id)
      return this.addMarkerAt(safePositionMs)
    },

    removeMarker(markerId: string): boolean {
      const index = this.markers.findIndex((marker) => marker.id === markerId)
      if (index < 0) return false
      const [marker] = this.markers.splice(index, 1)
      const sent = sendBridge('PROJECT_MARKER_REMOVE', { markerId })
      if (!sent) {
        useNotificationsStore().pushError('Marker was removed locally, but the backend is not connected.')
      }
      log.info('project', `removeMarker id=${markerId} position=${marker?.positionMs ?? '?'}`)
      return true
    },

    moveMarker(markerId: string, positionMs: number): boolean {
      const marker = this.markers.find((m) => m.id === markerId)
      if (!marker) return false
      const safePositionMs = Math.max(0, Math.round(positionMs))
      if (Math.abs(marker.positionMs - safePositionMs) < 1) return true
      const existing = this.markers.find((m) => m.id !== markerId && Math.abs(m.positionMs - safePositionMs) < 1)
      if (existing) return false
      marker.positionMs = safePositionMs
      this.markers.sort((a, b) => a.positionMs - b.positionMs)
      const sent = sendBridge('PROJECT_MARKER_MOVE', {
        markerId,
        positionMs: safePositionMs
      })
      if (!sent) {
        useNotificationsStore().pushError('Marker was moved locally, but the backend is not connected.')
      }
      return true
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

    /**
     * Fire-and-forget autosave tick. Returns a promise the autosave
     * manager awaits to know whether to update the manifest from
     * `pending=true` to `pending=false`. Resolves with `{ ok: false }`
     * after a short timeout if the backend never acks (so the manager
     * doesn't leak resolvers forever).
     */
    autosaveAndWait(filePath: string): Promise<{ ok: boolean; error?: string }> {
      // If a prior tick for the same filePath is still pending, reject
      // it so its resolver doesn't fire on the new tick's ack.
      const existing = pendingAutosaveResolvers.get(filePath)
      if (existing) {
        existing({ ok: false, error: 'Superseded by a newer autosave' })
        pendingAutosaveResolvers.delete(filePath)
      }
      const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        pendingAutosaveResolvers.set(filePath, resolve)
      })
      const sent = sendBridge('PROJECT_AUTOSAVE', {
        filePath,
        viewScrollX: this.viewScrollX ?? undefined
      })
      if (!sent) {
        pendingAutosaveResolvers.delete(filePath)
        return Promise.resolve({ ok: false, error: 'Backend is not connected' })
      }
      // Safety timeout: a backend that drops the ack must not leak a
      // resolver. Mirrors the explicit-save timeout.
      const timeoutId = setTimeout(() => {
        const r = pendingAutosaveResolvers.get(filePath)
        if (r) {
          r({ ok: false, error: 'Autosave timed out' })
          pendingAutosaveResolvers.delete(filePath)
        }
      }, PENDING_SAVE_TIMEOUT_MS)
      // Wrap the resolve so it always clears the timeout. Replace the
      // map entry with the wrapped version so the bridge-side dispatch
      // calls the wrapped one.
      const original = pendingAutosaveResolvers.get(filePath)!
      const wrapped = (result: { ok: boolean; error?: string }): void => {
        clearTimeout(timeoutId)
        original(result)
      }
      pendingAutosaveResolvers.set(filePath, wrapped)
      return promise
    },

    /** Called by `bridgeService` on every PROJECT_AUTOSAVED. */
    notifyAutosaveAck(filePath: string, ok: boolean, error?: string): void {
      const resolver = pendingAutosaveResolvers.get(filePath)
      if (resolver) {
        pendingAutosaveResolvers.delete(filePath)
        resolver({ ok, error })
      }
    },

    /** Send PROJECT_LOAD with the path the user picked in the OS dialog. */
    requestLoad(filePath: string): void {
      log.info('project', `requestLoad path=${filePath}`)
      sendBridge('PROJECT_LOAD', { filePath })
    },

    /**
     * Crash-recovery load. The backend rebuilds the engine from
     * `autosavePath` but seeds `session.currentPath` to `originalPath`
     * (or empty when null) and flips the dirty flag to true so the
     * user is steered to a deliberate File > Save.
     */
    requestLoadRecovery(
      autosavePath: string,
      originalPath: string | null,
      projectId?: string
    ): Promise<{ ok: boolean; error?: string }> {
      log.info(
        'project',
        `requestLoadRecovery autosavePath=${autosavePath} originalPath=${originalPath ?? 'null'} projectId=${projectId ?? 'null'}`
      )
      this.pendingRecoveredProjectId = projectId ?? null
      if (pendingRecoveryLoadResolver) {
        pendingRecoveryLoadResolver({ ok: false, error: 'Superseded by a newer recovery load' })
      }
      if (pendingRecoveryLoadTimeout) {
        clearTimeout(pendingRecoveryLoadTimeout)
        pendingRecoveryLoadTimeout = null
      }
      const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        pendingRecoveryLoadResolver = resolve
        pendingRecoveryLoadTimeout = setTimeout(() => {
          pendingRecoveryLoadTimeout = null
          this.pendingRecoveredProjectId = null
          if (!pendingRecoveryLoadResolver) return
          pendingRecoveryLoadResolver({
            ok: false,
            error: 'Timed out waiting for backend recovery load acknowledgement'
          })
          pendingRecoveryLoadResolver = null
        }, PENDING_LOAD_TIMEOUT_MS)
      })
      const sent = sendBridge('PROJECT_LOAD_RECOVERY', { autosavePath, originalPath })
      if (!sent) {
        if (pendingRecoveryLoadTimeout) {
          clearTimeout(pendingRecoveryLoadTimeout)
          pendingRecoveryLoadTimeout = null
        }
        this.pendingRecoveredProjectId = null
        pendingRecoveryLoadResolver?.({ ok: false, error: 'Backend is not connected' })
        pendingRecoveryLoadResolver = null
      }
      return promise
    },

    notifyProjectLoadFailed(error?: string): void {
      if (pendingRecoveryLoadTimeout) {
        clearTimeout(pendingRecoveryLoadTimeout)
        pendingRecoveryLoadTimeout = null
      }
      this.pendingRecoveredProjectId = null
      if (pendingRecoveryLoadResolver) {
        pendingRecoveryLoadResolver({ ok: false, error })
        pendingRecoveryLoadResolver = null
      }
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
