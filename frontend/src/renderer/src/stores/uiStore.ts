// UI / layout preferences — sizes of resizable panels, persisted across
// restarts via the main-process `preferences.json`.
//
// The store hydrates itself from disk on app startup (`hydrate()`), and any
// subsequent setter call pushes the new value back to main (debounced) so
// the on-disk copy stays in sync.

import { defineStore } from 'pinia'

export type TimelineScrollEdge = 'start' | 'end'
export type TimelineScrollRequest =
  | { edge: TimelineScrollEdge; id: number }
  | { positionMs: number; id: number }

interface UiState {
  trackHeaderWidth: number
  libraryPanelHeight: number
  /** Continuous-follow auto-scroll during playback. When false the
   *  viewport stays put and the playhead can run off the right edge. */
  followPlayback: boolean
  /** Show cover art / fallback thumbnails on library tiles. */
  showLibraryTileImages: boolean
  /** Live horizontal-zoom value (px per second). NOT persisted to
   *  preferences.json — this just mirrors `geometry.pxPerSecond` from
   *  the timeline so other components (e.g. StatusBar) can show the
   *  current zoom without reaching into the timeline composable. The
   *  per-project zoom is persisted separately via
   *  `projectStore.viewPxPerSecond`. */
  zoomPxPerSecond: number
  /** One-shot request for TimelineView to jump its horizontal scroll. */
  timelineScrollRequest: TimelineScrollRequest | null
  /** True once `hydrate()` has read the saved values from main. */
  hydrated: boolean
}

let nextTimelineScrollRequestId = 1

// Must match `DEFAULT_PREFS.ui` in src/main/index.ts.
const DEFAULTS = {
  trackHeaderWidth: 175,
  libraryPanelHeight: 180,
  followPlayback: true,
  showLibraryTileImages: true
} as const

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
} = {}

/**
 * Debounced push of UI preference changes back to main. Resize handles
 * fire continuously while dragged, so we coalesce ~150 ms of changes into
 * a single IPC + disk write.
 */
function schedulePush(partial: {
  trackHeaderWidth?: number
  libraryPanelHeight?: number
  followPlayback?: boolean
  showLibraryTileImages?: boolean
}): void {
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
    zoomPxPerSecond: 100,
    timelineScrollRequest: null,
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
      } catch (err) {
        console.warn('[uiStore] hydrate failed, using defaults:', err)
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
    }
  }
})
