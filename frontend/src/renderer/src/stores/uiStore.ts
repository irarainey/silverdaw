// UI/layout preferences persisted via main-process `preferences.json`.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type { SkipButtonTarget, WaveformDisplayMode } from '@shared/types'
import type { AutomationParamId } from '@shared/bridge-protocol'

export type { SkipButtonTarget, WaveformDisplayMode }

export type TimelineScrollEdge = 'start' | 'end'
export type TimelineScrollRequest =
  | { edge: TimelineScrollEdge; id: number }
  | { positionMs: number; id: number }
export type TimelineZoomAction = 'in' | 'out' | 'reset'
/** One-shot TimelineView zoom request; `absolute` is px/sec. */
export type TimelineZoomRequest =
  | { kind: 'step'; action: TimelineZoomAction; id: number }
  | { kind: 'absolute'; pxPerSecond: number; id: number }
/** One-shot request to scroll a track row into the visible vertical band. */
export type TimelineRevealTrackRequest = { trackId: string; id: number }

interface UiState {
  trackHeaderWidth: number
  libraryPanelHeight: number
  followPlayback: boolean
  showLibraryTileImages: boolean
  matchProjectTempoOnDrop: boolean
  /** App preference (default on): dropping the first clip on a new project seeds the project tempo. */
  seedProjectTempoFromFirstClip: boolean
  /** App preference (default on): after analysis, snap a clip so its detected beats
   *  align to the project beat grid. Clips without a beat grid are left untouched. */
  alignClipsToGridOnAnalysis: boolean
  /** Delete a removed library item's generated project files instead of only unlinking it. */
  cleanupProjectFiles: boolean
  /** Application default for new projects; existing projects keep their stored rate. */
  defaultProjectSampleRate: number
  skipButtonTarget: SkipButtonTarget
  waveformDisplayMode: WaveformDisplayMode
  libraryPanelCollapsed: boolean
  /** Live timeline zoom mirror (px/sec); per-project zoom is persisted elsewhere. */
  zoomPxPerSecond: number
  timelineScrollRequest: TimelineScrollRequest | null
  timelineZoomRequest: TimelineZoomRequest | null
  timelineRevealTrackRequest: TimelineRevealTrackRequest | null
  /** Per-track automation lane: trackId -> shown parameter. Present = lane expanded.
   *  Session UI state (not persisted with the project). */
  automationLanes: Record<string, AutomationParamId>
  /** Per-track automation-lane height (px); falls back to the default when absent. */
  automationLaneHeights: Record<string, number>
  /** Clipboard for an automation curve copied from a lane (paste into another). */
  automationClipboard: { paramId: AutomationParamId; points: { timeMs: number; value: number }[] } | null
  /** Selected automation breakpoint for keyboard nudging; null when none. */
  selectedAutomationPoint: { trackId: string; paramId: AutomationParamId; index: number } | null
  /** Hover readout for an automation breakpoint (client px + label); null when away. */
  automationHoverTip: { x: number; y: number; text: string } | null
  /** Global shortcuts defer while the Clip Editor preview dialog is open. */
  clipEditorOpen: boolean
  hydrated: boolean
}

let nextTimelineScrollRequestId = 1
let nextTimelineZoomRequestId = 1
let nextTimelineRevealTrackRequestId = 1

// Must match `DEFAULT_PREFS.ui` in src/main/index.ts.
const DEFAULTS = {
  trackHeaderWidth: 175,
  libraryPanelHeight: 180,
  followPlayback: true,
  showLibraryTileImages: true,
  matchProjectTempoOnDrop: true,
  seedProjectTempoFromFirstClip: true,
  alignClipsToGridOnAnalysis: true,
  cleanupProjectFiles: false,
  defaultProjectSampleRate: 44100,
  skipButtonTarget: 'markers',
  waveformDisplayMode: 'summary',
  libraryPanelCollapsed: false
} as const

const SUPPORTED_PROJECT_SAMPLE_RATES = new Set([44100, 48000])

function sanitiseProjectSampleRate(n: unknown): number {
  return typeof n === 'number' && SUPPORTED_PROJECT_SAMPLE_RATES.has(n)
    ? n
    : DEFAULTS.defaultProjectSampleRate
}

// Defensive clamps protect against corrupt persisted layout values.
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
  seedProjectTempoFromFirstClip?: boolean
  alignClipsToGridOnAnalysis?: boolean
  cleanupProjectFiles?: boolean
  skipButtonTarget?: SkipButtonTarget
  waveformDisplayMode?: WaveformDisplayMode
  libraryPanelCollapsed?: boolean
} = {}

interface UiPushPayload {
  trackHeaderWidth?: number
  libraryPanelHeight?: number
  followPlayback?: boolean
  showLibraryTileImages?: boolean
  matchProjectTempoOnDrop?: boolean
  seedProjectTempoFromFirstClip?: boolean
  alignClipsToGridOnAnalysis?: boolean
  cleanupProjectFiles?: boolean
  defaultProjectSampleRate?: number
  skipButtonTarget?: SkipButtonTarget
  waveformDisplayMode?: WaveformDisplayMode
  libraryPanelCollapsed?: boolean
}

/** Coalesces resize-driven preference writes into one IPC + disk write. */
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
    seedProjectTempoFromFirstClip: DEFAULTS.seedProjectTempoFromFirstClip,
    alignClipsToGridOnAnalysis: DEFAULTS.alignClipsToGridOnAnalysis,
    cleanupProjectFiles: DEFAULTS.cleanupProjectFiles,
    defaultProjectSampleRate: DEFAULTS.defaultProjectSampleRate,
    skipButtonTarget: DEFAULTS.skipButtonTarget,
    waveformDisplayMode: DEFAULTS.waveformDisplayMode,
    libraryPanelCollapsed: DEFAULTS.libraryPanelCollapsed,
    zoomPxPerSecond: 100,
    timelineScrollRequest: null,
    timelineZoomRequest: null,
    timelineRevealTrackRequest: null,
    automationLanes: {},
    automationLaneHeights: {},
    automationClipboard: null,
    selectedAutomationPoint: null,
    automationHoverTip: null,
    clipEditorOpen: false,
    hydrated: false
  }),

  actions: {
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
        this.seedProjectTempoFromFirstClip =
          typeof saved.seedProjectTempoFromFirstClip === 'boolean'
            ? saved.seedProjectTempoFromFirstClip
            : DEFAULTS.seedProjectTempoFromFirstClip
        this.alignClipsToGridOnAnalysis =
          typeof saved.alignClipsToGridOnAnalysis === 'boolean'
            ? saved.alignClipsToGridOnAnalysis
            : DEFAULTS.alignClipsToGridOnAnalysis
        this.cleanupProjectFiles =
          typeof saved.cleanupProjectFiles === 'boolean'
            ? saved.cleanupProjectFiles
            : DEFAULTS.cleanupProjectFiles
        this.defaultProjectSampleRate = sanitiseProjectSampleRate(saved.defaultProjectSampleRate)
        this.skipButtonTarget =
          saved.skipButtonTarget === 'markers' || saved.skipButtonTarget === 'timelineEnds'
            ? saved.skipButtonTarget
            : DEFAULTS.skipButtonTarget
        this.waveformDisplayMode =
          saved.waveformDisplayMode === 'stereo' || saved.waveformDisplayMode === 'summary'
            ? saved.waveformDisplayMode
            : DEFAULTS.waveformDisplayMode
        this.libraryPanelCollapsed =
          typeof saved.libraryPanelCollapsed === 'boolean'
            ? saved.libraryPanelCollapsed
            : DEFAULTS.libraryPanelCollapsed
      } catch (err) {
        log.warn('ui', `hydrate failed, using defaults: ${String(err)}`)
      } finally {
        this.hydrated = true
        // If the bridge is already connected, push the just-loaded preference so the
        // backend has the persisted value (the READY handler covers the other ordering).
        this.syncSeedTempoPrefToBackend()
      }
    },

    setTrackHeaderWidth(value: number): void {
      const next = clampHeaderWidth(value)
      if (next === this.trackHeaderWidth) return
      this.trackHeaderWidth = next
      if (this.hydrated) schedulePush({ trackHeaderWidth: next })
    },

    setLibraryPanelHeight(value: number): void {
      const next = clampLibraryHeight(value)
      if (next === this.libraryPanelHeight) return
      this.libraryPanelHeight = next
      if (this.hydrated) schedulePush({ libraryPanelHeight: next })
    },

    setLibraryPanelCollapsed(value: boolean): void {
      if (this.libraryPanelCollapsed === value) return
      this.libraryPanelCollapsed = value
      if (this.hydrated) schedulePush({ libraryPanelCollapsed: value })
    },

    toggleLibraryPanelCollapsed(): void {
      this.setLibraryPanelCollapsed(!this.libraryPanelCollapsed)
    },

    setFollowPlayback(value: boolean): void {
      if (this.followPlayback === value) return
      this.followPlayback = value
      if (this.hydrated) schedulePush({ followPlayback: value })
    },

    setShowLibraryTileImages(value: boolean): void {
      if (this.showLibraryTileImages === value) return
      this.showLibraryTileImages = value
      if (this.hydrated) schedulePush({ showLibraryTileImages: value })
    },

    setMatchProjectTempoOnDrop(value: boolean): void {
      if (this.matchProjectTempoOnDrop === value) return
      this.matchProjectTempoOnDrop = value
      if (this.hydrated) schedulePush({ matchProjectTempoOnDrop: value })
    },

    setAlignClipsToGridOnAnalysis(value: boolean): void {
      if (this.alignClipsToGridOnAnalysis === value) return
      this.alignClipsToGridOnAnalysis = value
      if (this.hydrated) schedulePush({ alignClipsToGridOnAnalysis: value })
    },

    setSeedProjectTempoFromFirstClip(value: boolean): void {
      if (this.seedProjectTempoFromFirstClip === value) return
      this.seedProjectTempoFromFirstClip = value
      if (this.hydrated) {
        schedulePush({ seedProjectTempoFromFirstClip: value })
        this.syncSeedTempoPrefToBackend()
      }
    },

    /** Push the first-clip tempo-seed preference to the backend (on change and on every reconnect). */
    syncSeedTempoPrefToBackend(): void {
      sendBridge('PROJECT_SET_SEED_TEMPO_PREF', { enabled: this.seedProjectTempoFromFirstClip })
    },

    setCleanupProjectFiles(value: boolean): void {
      if (this.cleanupProjectFiles === value) return
      this.cleanupProjectFiles = value
      if (this.hydrated) schedulePush({ cleanupProjectFiles: value })
    },

    setSkipButtonTarget(value: SkipButtonTarget): void {
      if (this.skipButtonTarget === value) return
      this.skipButtonTarget = value
      if (this.hydrated) schedulePush({ skipButtonTarget: value })
    },

    setWaveformDisplayMode(value: WaveformDisplayMode): void {
      if (this.waveformDisplayMode === value) return
      this.waveformDisplayMode = value
      if (this.hydrated) schedulePush({ waveformDisplayMode: value })
    },

    /** Rejects unsupported defaults; existing projects keep their stored rate. */
    setDefaultProjectSampleRate(value: number): void {
      if (!SUPPORTED_PROJECT_SAMPLE_RATES.has(value)) return
      if (this.defaultProjectSampleRate === value) return
      this.defaultProjectSampleRate = value
      if (this.hydrated) schedulePush({ defaultProjectSampleRate: value })
    },

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

    /** Ask the timeline to scroll the given track row into the visible band. */
    requestRevealTrack(trackId: string): void {
      if (!trackId) return
      this.timelineRevealTrackRequest = {
        trackId,
        id: nextTimelineRevealTrackRequestId++
      }
    },

    /** Show a parameter's automation lane on a track (or collapse it with null). */
    setTrackAutomationLane(trackId: string, paramId: AutomationParamId | null): void {
      const next = { ...this.automationLanes }
      if (paramId) next[trackId] = paramId
      else delete next[trackId]
      this.automationLanes = next
    },

    /** Resize a track's automation lane (clamped so the readout always fits). */
    setTrackAutomationLaneHeight(trackId: string, heightPx: number): void {
      this.automationLaneHeights = {
        ...this.automationLaneHeights,
        [trackId]: Math.max(76, Math.min(220, Math.round(heightPx)))
      }
    },

    /** Copy a lane's curve to the clipboard for pasting into another track. */
    copyAutomationCurve(paramId: AutomationParamId, points: { timeMs: number; value: number }[]): void {
      this.automationClipboard = { paramId, points: points.map((p) => ({ ...p })) }
    },

    /** Track the breakpoint to be keyboard-nudged (set on grab, cleared otherwise). */
    setSelectedAutomationPoint(p: { trackId: string; paramId: AutomationParamId; index: number } | null): void {
      this.selectedAutomationPoint = p
    },

    requestTimelineZoom(action: TimelineZoomAction): void {
      this.timelineZoomRequest = {
        kind: 'step',
        action,
        id: nextTimelineZoomRequestId++
      }
    },

    /** Absolute zoom in px/sec; range is clamped by timeline geometry. */
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
