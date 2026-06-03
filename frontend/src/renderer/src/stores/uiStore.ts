// UI / layout preferences — sizes of resizable panels, persisted across
// restarts via the main-process `preferences.json`.
//
// The store hydrates itself from disk on app startup (`hydrate()`), and any
// subsequent setter call pushes the new value back to main (debounced) so
// the on-disk copy stays in sync.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'
import type { SkipButtonTarget } from '@shared/types'

export type { SkipButtonTarget }

export type TimelineScrollEdge = 'start' | 'end'
export type TimelineScrollRequest =
  | { edge: TimelineScrollEdge; id: number }
  | { positionMs: number; id: number }
export type TimelineZoomAction = 'in' | 'out' | 'reset'
/** A one-shot zoom request consumed by TimelineView. `step` nudges by the
 *  fixed zoom increment (or resets to default); `absolute` jumps straight to
 *  a target px/sec (used by the View ▸ Zoom Presets menu). */
export type TimelineZoomRequest =
  | { kind: 'step'; action: TimelineZoomAction; id: number }
  | { kind: 'absolute'; pxPerSecond: number; id: number }

interface UiState {
  trackHeaderWidth: number
  libraryPanelHeight: number
  /** Continuous-follow auto-scroll during playback. When false the
   *  viewport stays put and the playhead can run off the right edge. */
  followPlayback: boolean
  /** Show cover art / fallback thumbnails on library tiles. */
  showLibraryTileImages: boolean
  /** Auto-warp dropped clips to match project BPM. */
  matchProjectTempoOnDrop: boolean
  /** Application default for new-project sample rate (Hz). Mirrors
   *  `preferences.json.ui.defaultProjectSampleRate`. Surfaced in
   *  Preferences ▸ Audio so the user can change the default applied
   *  to freshly-created projects without touching existing ones. */
  defaultProjectSampleRate: number
  /** What the transport previous / next buttons jump to. `timelineEnds`
   *  seeks the project start / end; `markers` steps through the timeline
   *  markers (falling back to start / end past the last marker). */
  skipButtonTarget: SkipButtonTarget
  /** Live horizontal-zoom value (px per second). NOT persisted to
   *  preferences.json — this just mirrors `geometry.pxPerSecond` from
   *  the timeline so other components (e.g. StatusBar) can show the
   *  current zoom without reaching into the timeline composable. The
   *  per-project zoom is persisted separately via
   *  `projectStore.viewPxPerSecond`. */
  zoomPxPerSecond: number
  /** One-shot request for TimelineView to jump its horizontal scroll. */
  timelineScrollRequest: TimelineScrollRequest | null
  /** One-shot request for TimelineView to adjust zoom from a global shortcut. */
  timelineZoomRequest: TimelineZoomRequest | null
  /** True while the Clip Editor preview dialog is open. Global keyboard
   *  shortcuts (Space play/pause etc.) should defer to the dialog while
   *  this is set. */
  clipEditorOpen: boolean
  /** True once `hydrate()` has read the saved values from main. */
  hydrated: boolean
}

let nextTimelineScrollRequestId = 1
let nextTimelineZoomRequestId = 1

// Must match `DEFAULT_PREFS.ui` in src/main/index.ts.
const DEFAULTS = {
  trackHeaderWidth: 175,
  libraryPanelHeight: 180,
  followPlayback: true,
  showLibraryTileImages: true,
  matchProjectTempoOnDrop: true,
  defaultProjectSampleRate: 44100,
  skipButtonTarget: 'timelineEnds'
} as const

const SUPPORTED_PROJECT_SAMPLE_RATES = new Set([44100, 48000])

function sanitiseProjectSampleRate(n: unknown): number {
  return typeof n === 'number' && SUPPORTED_PROJECT_SAMPLE_RATES.has(n)
    ? n
    : DEFAULTS.defaultProjectSampleRate
}

// Clamps mirror the resize-handle clamps in the components, but applied
// defensively here too so a corrupt prefs file can't render an unreachable
// panel.
const MIN_TRACK_HEADER_WIDTH = 120
const MAX_TRACK_HEADER_WIDTH = 480
const MIN_LIBRARY_PANEL_HEIGHT = 80
const MAX_LIBRARY_PANEL_HEIGHT = 2000

function clampHeaderWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.trackHeaderWidth
  return Math.round(Math.max(MIN_TRACK_HEADER_WIDTH, Math.min(MAX_TRACK_HEADER_WIDTH, n)))
}

function clampLibraryHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.libraryPanelHeight
  return Math.round(Math.max(MIN_LIBRARY_PANEL_HEIGHT, Math.min(MAX_LIBRARY_PANEL_HEIGHT, n)))
}

let pushTimer: ReturnType<typeof setTimeout> | null = null
let pendingPush: {
  trackHeaderWidth?: number
  libraryPanelHeight?: number
  followPlayback?: boolean
  showLibraryTileImages?: boolean
  matchProjectTempoOnDrop?: boolean
  skipButtonTarget?: SkipButtonTarget
} = {}

interface UiPushPayload {
  trackHeaderWidth?: number
  libraryPanelHeight?: number
  followPlayback?: boolean
  showLibraryTileImages?: boolean
  matchProjectTempoOnDrop?: boolean
  defaultProjectSampleRate?: number
  skipButtonTarget?: SkipButtonTarget
}

/**
 * Debounced push of UI preference changes back to main. Resize handles
 * fire continuously while dragged, so we coalesce ~150 ms of changes into
 * a single IPC + disk write.
 */
function schedulePush(partial: UiPushPayload): void {
  pendingPush = { ...pendingPush, ...partial }
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    const payload = pendingPush
    pendingPush = {}
    pushTimer = null
    window.silverdaw.setUiPreferences(payload)
  }, 150)
}

export const useUiStore = defineStore('ui', {
  state: (): UiState => ({
    trackHeaderWidth: DEFAULTS.trackHeaderWidth,
    libraryPanelHeight: DEFAULTS.libraryPanelHeight,
    followPlayback: DEFAULTS.followPlayback,
    showLibraryTileImages: DEFAULTS.showLibraryTileImages,
    matchProjectTempoOnDrop: DEFAULTS.matchProjectTempoOnDrop,
    defaultProjectSampleRate: DEFAULTS.defaultProjectSampleRate,
    skipButtonTarget: DEFAULTS.skipButtonTarget,
    zoomPxPerSecond: 100,
    timelineScrollRequest: null,
    timelineZoomRequest: null,
    clipEditorOpen: false,
    hydrated: false
  }),

  actions: {
    /**
     * Pull the persisted UI prefs from main and apply them. Idempotent;
     * safe to call multiple times (the second call is a no-op).
     */
    async hydrate(): Promise<void> {
      if (this.hydrated) return
      try {
        const saved = await window.silverdaw.getUiPreferences()
        this.trackHeaderWidth = clampHeaderWidth(saved.trackHeaderWidth)
        this.libraryPanelHeight = clampLibraryHeight(saved.libraryPanelHeight)
        this.followPlayback =
          typeof saved.followPlayback === 'boolean' ? saved.followPlayback : DEFAULTS.followPlayback
        this.showLibraryTileImages =
          typeof saved.showLibraryTileImages === 'boolean'
            ? saved.showLibraryTileImages
            : DEFAULTS.showLibraryTileImages
        this.matchProjectTempoOnDrop =
          typeof saved.matchProjectTempoOnDrop === 'boolean'
            ? saved.matchProjectTempoOnDrop
            : DEFAULTS.matchProjectTempoOnDrop
        this.defaultProjectSampleRate = sanitiseProjectSampleRate(saved.defaultProjectSampleRate)
        this.skipButtonTarget =
          saved.skipButtonTarget === 'markers' || saved.skipButtonTarget === 'timelineEnds'
            ? saved.skipButtonTarget
            : DEFAULTS.skipButtonTarget
      } catch (err) {
        log.warn('ui', `hydrate failed, using defaults: ${String(err)}`)
      } finally {
        this.hydrated = true
      }
    },

    /** Update the track-header column width and persist. */
    setTrackHeaderWidth(value: number): void {
      const next = clampHeaderWidth(value)
      if (next === this.trackHeaderWidth) return
      this.trackHeaderWidth = next
      if (this.hydrated) schedulePush({ trackHeaderWidth: next })
    },

    /** Update the library panel's height and persist. */
    setLibraryPanelHeight(value: number): void {
      const next = clampLibraryHeight(value)
      if (next === this.libraryPanelHeight) return
      this.libraryPanelHeight = next
      if (this.hydrated) schedulePush({ libraryPanelHeight: next })
    },

    /** Toggle follow-playback. Persists immediately (no debounce needed
     *  since it's a click, not a continuous resize). */
    setFollowPlayback(value: boolean): void {
      if (this.followPlayback === value) return
      this.followPlayback = value
      if (this.hydrated) schedulePush({ followPlayback: value })
    },

    /** Toggle cover art / fallback thumbnails on library tiles. */
    setShowLibraryTileImages(value: boolean): void {
      if (this.showLibraryTileImages === value) return
      this.showLibraryTileImages = value
      if (this.hydrated) schedulePush({ showLibraryTileImages: value })
    },

    /** Toggle auto-warp-on-drop. */
    setMatchProjectTempoOnDrop(value: boolean): void {
      if (this.matchProjectTempoOnDrop === value) return
      this.matchProjectTempoOnDrop = value
      if (this.hydrated) schedulePush({ matchProjectTempoOnDrop: value })
    },

    /** Choose what the transport previous / next buttons jump to. */
    setSkipButtonTarget(value: SkipButtonTarget): void {
      if (this.skipButtonTarget === value) return
      this.skipButtonTarget = value
      if (this.hydrated) schedulePush({ skipButtonTarget: value })
    },

    /** Update the application default for new-project sample rate.
     *  Snaps to the supported whitelist; out-of-set values are
     *  rejected so a manual prefs-file edit can't park us on an
     *  unsupported rate. Existing projects keep their stored rate. */
    setDefaultProjectSampleRate(value: number): void {
      if (!SUPPORTED_PROJECT_SAMPLE_RATES.has(value)) return
      if (this.defaultProjectSampleRate === value) return
      this.defaultProjectSampleRate = value
      if (this.hydrated) schedulePush({ defaultProjectSampleRate: value })
    },

    /** Update the live zoom mirror. Renderer-only — not persisted to
     *  preferences (per-project zoom lives in `projectStore.viewPxPerSecond`). */
    setZoomPxPerSecond(value: number): void {
      if (!Number.isFinite(value) || value <= 0) return
      if (this.zoomPxPerSecond === value) return
      this.zoomPxPerSecond = value
    },

    requestTimelineScroll(edge: TimelineScrollEdge): void {
      this.timelineScrollRequest = {
        edge,
        id: nextTimelineScrollRequestId++
      }
    },

    requestTimelineScrollToPosition(positionMs: number): void {
      if (!Number.isFinite(positionMs) || positionMs < 0) return
      this.timelineScrollRequest = {
        positionMs,
        id: nextTimelineScrollRequestId++
      }
    },

    requestTimelineZoom(action: TimelineZoomAction): void {
      this.timelineZoomRequest = {
        kind: 'step',
        action,
        id: nextTimelineZoomRequestId++
      }
    },

    /** Request an absolute zoom level (px per second), e.g. from a preset.
     *  Out-of-range values are clamped downstream by the timeline geometry. */
    requestTimelineZoomTo(pxPerSecond: number): void {
      if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return
      this.timelineZoomRequest = {
        kind: 'absolute',
        pxPerSecond,
        id: nextTimelineZoomRequestId++
      }
    }
  }
})
