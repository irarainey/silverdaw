// UI / layout preferences — sizes of resizable panels, persisted across
// restarts via the main-process `preferences.json`.
//
// The store hydrates itself from disk on app startup (`hydrate()`), and any
// subsequent setter call pushes the new value back to main (debounced) so
// the on-disk copy stays in sync.

import { defineStore } from 'pinia'

interface UiState {
  trackHeaderWidth: number
  libraryPanelHeight: number
  /** True once `hydrate()` has read the saved values from main. */
  hydrated: boolean
}

// Must match `DEFAULT_PREFS.ui` in src/main/index.ts.
const DEFAULTS = {
  trackHeaderWidth: 175,
  libraryPanelHeight: 180
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
let pendingPush: { trackHeaderWidth?: number; libraryPanelHeight?: number } = {}

/**
 * Debounced push of UI preference changes back to main. Resize handles
 * fire continuously while dragged, so we coalesce ~150 ms of changes into
 * a single IPC + disk write.
 */
function schedulePush(partial: { trackHeaderWidth?: number; libraryPanelHeight?: number }): void {
  pendingPush = { ...pendingPush, ...partial }
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    const payload = pendingPush
    pendingPush = {}
    pushTimer = null
    window.rook.setUiPreferences(payload)
  }, 150)
}

export const useUiStore = defineStore('ui', {
  state: (): UiState => ({
    trackHeaderWidth: DEFAULTS.trackHeaderWidth,
    libraryPanelHeight: DEFAULTS.libraryPanelHeight,
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
        const saved = await window.rook.getUiPreferences()
        this.trackHeaderWidth = clampHeaderWidth(saved.trackHeaderWidth)
        this.libraryPanelHeight = clampLibraryHeight(saved.libraryPanelHeight)
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
    }
  }
})
