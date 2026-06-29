import { app } from 'electron'
import { dirname, join, resolve as pathResolve } from 'node:path'
import type { DebugPreferences, SkipButtonTarget, WaveformDisplayMode } from '../shared/types'
import type { StemQuality, VocalEnhanceStrength, DrumEnhanceStrength, BassEnhanceStrength, OtherEnhanceStrength } from '../shared/bridge/outbound'

export interface WindowPrefs {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface UiPrefs {
  trackHeaderWidth: number
  libraryPanelHeight: number
  followPlayback: boolean
  showLibraryTileImages: boolean
  /** Auto-warp library drops to project BPM when source BPM is usable. */
  matchProjectTempoOnDrop: boolean
  /** Delete a removed library item's generated project files (stems/samples WAVs
   *  and orphaned cover/tag media). Off by default — removal only unlinks. */
  cleanupProjectFiles: boolean
  /** Default `targetSampleRate` for new projects; only 44 100 and 48 000 are accepted. */
  defaultProjectSampleRate: number
  skipButtonTarget: SkipButtonTarget
  waveformDisplayMode: WaveformDisplayMode
  libraryPanelCollapsed: boolean
}

export type DebugPrefs = DebugPreferences

export interface ToastPrefs {
  enabled: boolean
}

// Default dialog folders never grant audio read access; trusted picks still drive the allow-list.
export interface PathPrefs {
  defaultProjectDir: string
  defaultClipDir: string
  /**
   * Optional override pointing at a user-supplied stem-separation model
   * directory (the "locate existing model" flow). Empty / undefined means the
   * app-managed download location is used.
   */
  stemModelDir?: string
}

// Stem-separation preferences. GPU acceleration is OPT-IN (default off): on some
// GPUs/drivers, running htdemucs through DirectML can trigger a TDR (Timeout
// Detection and Recovery) driver reset that blacks out / corrupts the desktop,
// so we never enable it without the user explicitly choosing it. When on, the
// dispatch path still gates it behind hardware detection AND a DirectML-capable
// backend build, falling back to the CPU otherwise (see PreferencesStemsTab).
// `quality` persists the last-used separation preset so the picker dialog
// reopens on the user's preferred choice instead of resetting each time.
// `enhanceVocals` (default off) gates the optional post-separation vocal
// cleanup; `vocalEnhanceStrength` persists its intensity. `enhanceDrums` /
// `drumEnhanceStrength` and `enhanceBass` / `bassEnhanceStrength` do the same
// for the drums and bass stems, and `enhanceOther` / `otherEnhanceStrength` for
// the other/residual stem.
export interface StemPrefs {
  useGpu: boolean
  quality: StemQuality
  // Use the optional Mel-Band RoFormer "Vocal Quality Pack" for higher-quality
  // vocals when it is installed (default off; ignored if the pack is absent).
  useVocalPack: boolean
  // Use the optional 4-stem BS-RoFormer "Rhythm Quality Pack" for higher-quality
  // drums + bass when it is installed (default off; ignored if the pack is absent).
  useRhythmPack: boolean
  enhanceVocals: boolean
  vocalEnhanceStrength: VocalEnhanceStrength
  enhanceDrums: boolean
  drumEnhanceStrength: DrumEnhanceStrength
  enhanceBass: boolean
  bassEnhanceStrength: BassEnhanceStrength
  enhanceOther: boolean
  otherEnhanceStrength: OtherEnhanceStrength
}

const STEM_QUALITIES: readonly StemQuality[] = ['fast', 'balanced', 'best']
// Shared by the vocal and drum cleanup pickers — both use the same intensity set.
const STEM_ENHANCE_STRENGTHS: readonly VocalEnhanceStrength[] = ['light', 'medium', 'strong']

// Renderer owns autosave timing; main owns the project-scoped files.
export interface AutosavePrefs {
  enabled: boolean
  /** Clamped 5..600 so corrupt prefs cannot spam autosaves. */
  intervalSeconds: number
}

// Persisted output device is passed at backend spawn; unavailable devices fall back at runtime.
export interface AudioOutputPrefs {
  typeName: string | null
  deviceName: string | null
}

/**
 * User override for the output keep-awake policy. `auto` follows the backend's USB-bus
 * classification; `on` forces the keep-alive dither + first-play wake burst (for a USB DAC that
 * classification misses); `off` disables it (for a USB DAC that does not need it, or any endpoint
 * where the wake burst becomes audible).
 */
export type KeepAwakeMode = 'auto' | 'on' | 'off'

export interface Preferences {
  window: WindowPrefs
  ui: UiPrefs
  debug: DebugPrefs
  toasts: ToastPrefs
  paths: PathPrefs
  autosave: AutosavePrefs
  audioOutput: AudioOutputPrefs
  keepAwakeMode: KeepAwakeMode
  stems: StemPrefs
  /** MRU `.silverdaw` paths, newest first, capped and case-insensitive. */
  recentProjects: string[]
}

export const MAX_RECENT_PROJECTS = 10
export const AUTOSAVE_MIN_SECONDS = 5
export const AUTOSAVE_MAX_SECONDS = 600
export const AUTOSAVE_DEFAULT_SECONDS = 30

// `app.getPath` is only safe after `app.whenReady`, so defaults are lazy.
function getApplicationDirectory(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : pathResolve(__dirname, '..', '..', '..')
}

export function getDefaultDebugLogDirectory(): string {
  return join(getApplicationDirectory(), 'debug')
}

export function buildDefaultPrefs(): Preferences {
  const home = app.getPath('home')
  // Prefer Music/Silverdaw, falling back to home when Music is unavailable.
  let musicDir = ''
  try {
    musicDir = app.getPath('music')
  } catch {
    musicDir = ''
  }
  const defaultProjectDir = musicDir ? join(musicDir, 'Silverdaw') : join(home, 'Silverdaw')
  const defaultClipDir = musicDir || defaultProjectDir
  return {
    window: { width: 1400, height: 900, maximized: false },
    ui: {
      trackHeaderWidth: 175,
      libraryPanelHeight: 180,
      followPlayback: true,
      showLibraryTileImages: true,
      matchProjectTempoOnDrop: true,
      cleanupProjectFiles: false,
      defaultProjectSampleRate: 44100,
      skipButtonTarget: 'timelineEnds',
      waveformDisplayMode: 'summary',
      libraryPanelCollapsed: false
    },
    debug: {
      loggingEnabled: false,
      devToolsEnabled: false,
      logDirectory: getDefaultDebugLogDirectory()
    },
    toasts: { enabled: true },
    paths: { defaultProjectDir, defaultClipDir },
    autosave: { enabled: true, intervalSeconds: AUTOSAVE_DEFAULT_SECONDS },
    audioOutput: { typeName: null, deviceName: null },
    keepAwakeMode: 'auto',
    stems: {
      useGpu: false,
      quality: 'balanced',
      useVocalPack: false,
      useRhythmPack: false,
      enhanceVocals: false,
      vocalEnhanceStrength: 'medium',
      enhanceDrums: false,
      drumEnhanceStrength: 'medium',
      enhanceBass: false,
      bassEnhanceStrength: 'medium',
      enhanceOther: false,
      otherEnhanceStrength: 'medium'
    },
    recentProjects: []
  }
}

export function normaliseDebugPrefs(saved: Partial<DebugPrefs> & { enabled?: boolean } | undefined, defaults: DebugPrefs): DebugPrefs {
  const legacyEnabled = typeof saved?.enabled === 'boolean' ? saved.enabled : undefined
  const hasSplitFlags =
    typeof saved?.loggingEnabled === 'boolean' ||
    typeof saved?.devToolsEnabled === 'boolean'
  const loggingEnabled =
    typeof saved?.loggingEnabled === 'boolean'
      ? saved.loggingEnabled
      : hasSplitFlags
        ? defaults.loggingEnabled
        : legacyEnabled ?? defaults.loggingEnabled
  const devToolsEnabled =
    typeof saved?.devToolsEnabled === 'boolean'
      ? saved.devToolsEnabled
      : hasSplitFlags
        ? defaults.devToolsEnabled
        : legacyEnabled ?? defaults.devToolsEnabled
  const savedLogDirectory = typeof saved?.logDirectory === 'string' ? saved.logDirectory.trim() : ''
  const logDirectory = savedLogDirectory.length > 0 ? savedLogDirectory : defaults.logDirectory
  return { loggingEnabled, devToolsEnabled, logDirectory }
}

export function clampAutosaveSeconds(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input) ? input : AUTOSAVE_DEFAULT_SECONDS
  if (value < AUTOSAVE_MIN_SECONDS) return AUTOSAVE_MIN_SECONDS
  if (value > AUTOSAVE_MAX_SECONDS) return AUTOSAVE_MAX_SECONDS
  return Math.round(value)
}

export function sanitiseRecentList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= MAX_RECENT_PROJECTS) break
  }
  return out
}

// Single source of truth for stem-prefs validation; a partial `prefs:setStems`
// update or a corrupt prefs file can never inject a wrong-typed value.
export function sanitiseStemPrefs(partial: unknown, base: StemPrefs): StemPrefs {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Partial<Record<keyof StemPrefs, unknown>>
  return {
    useGpu: boolOr(p.useGpu, base.useGpu),
    quality: STEM_QUALITIES.includes(p.quality as StemQuality)
      ? (p.quality as StemQuality)
      : base.quality,
    useVocalPack: boolOr(p.useVocalPack, base.useVocalPack),
    useRhythmPack: boolOr(p.useRhythmPack, base.useRhythmPack),
    enhanceVocals: boolOr(p.enhanceVocals, base.enhanceVocals),
    vocalEnhanceStrength: STEM_ENHANCE_STRENGTHS.includes(p.vocalEnhanceStrength as VocalEnhanceStrength)
      ? (p.vocalEnhanceStrength as VocalEnhanceStrength)
      : base.vocalEnhanceStrength,
    enhanceDrums: boolOr(p.enhanceDrums, base.enhanceDrums),
    drumEnhanceStrength: STEM_ENHANCE_STRENGTHS.includes(p.drumEnhanceStrength as DrumEnhanceStrength)
      ? (p.drumEnhanceStrength as DrumEnhanceStrength)
      : base.drumEnhanceStrength,
    enhanceBass: boolOr(p.enhanceBass, base.enhanceBass),
    bassEnhanceStrength: STEM_ENHANCE_STRENGTHS.includes(p.bassEnhanceStrength as BassEnhanceStrength)
      ? (p.bassEnhanceStrength as BassEnhanceStrength)
      : base.bassEnhanceStrength,
    enhanceOther: boolOr(p.enhanceOther, base.enhanceOther),
    otherEnhanceStrength: STEM_ENHANCE_STRENGTHS.includes(p.otherEnhanceStrength as OtherEnhanceStrength)
      ? (p.otherEnhanceStrength as OtherEnhanceStrength)
      : base.otherEnhanceStrength
  }
}

// A located model directory is kept only when it is a non-empty string; anything
// else clears the override so the app-managed download location is used.
export function sanitiseStemModelDir(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

// Defensive UI-layout clamps; mirror the renderer's uiStore bounds so a corrupt
// prefs file or a hostile renderer message cannot poison the persisted layout.
export const UI_TRACK_HEADER_WIDTH_MIN = 120
export const UI_TRACK_HEADER_WIDTH_MAX = 480
export const UI_LIBRARY_PANEL_HEIGHT_MIN = 80
export const UI_LIBRARY_PANEL_HEIGHT_MAX = 2000

const SUPPORTED_PROJECT_SAMPLE_RATES: ReadonlySet<number> = new Set([44100, 48000])
const SKIP_BUTTON_TARGETS: ReadonlySet<SkipButtonTarget> = new Set(['timelineEnds', 'markers'])
const WAVEFORM_DISPLAY_MODES: ReadonlySet<WaveformDisplayMode> = new Set(['summary', 'stereo'])

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.max(min, Math.min(max, value)))
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

// Single source of truth for UI-prefs validation. Each field is taken from
// `partial` only when it has the correct type / enum / range, otherwise the
// `base` value is kept — so a partial `prefs:setUi` update or a saved prefs file
// can never inject a wrong-typed or out-of-range UI value.
export function sanitiseUiPrefs(partial: unknown, base: UiPrefs): UiPrefs {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Partial<Record<keyof UiPrefs, unknown>>
  return {
    trackHeaderWidth: clampInt(
      p.trackHeaderWidth,
      UI_TRACK_HEADER_WIDTH_MIN,
      UI_TRACK_HEADER_WIDTH_MAX,
      base.trackHeaderWidth
    ),
    libraryPanelHeight: clampInt(
      p.libraryPanelHeight,
      UI_LIBRARY_PANEL_HEIGHT_MIN,
      UI_LIBRARY_PANEL_HEIGHT_MAX,
      base.libraryPanelHeight
    ),
    followPlayback: boolOr(p.followPlayback, base.followPlayback),
    showLibraryTileImages: boolOr(p.showLibraryTileImages, base.showLibraryTileImages),
    matchProjectTempoOnDrop: boolOr(p.matchProjectTempoOnDrop, base.matchProjectTempoOnDrop),
    cleanupProjectFiles: boolOr(p.cleanupProjectFiles, base.cleanupProjectFiles),
    defaultProjectSampleRate:
      typeof p.defaultProjectSampleRate === 'number' &&
      SUPPORTED_PROJECT_SAMPLE_RATES.has(p.defaultProjectSampleRate)
        ? p.defaultProjectSampleRate
        : base.defaultProjectSampleRate,
    skipButtonTarget: SKIP_BUTTON_TARGETS.has(p.skipButtonTarget as SkipButtonTarget)
      ? (p.skipButtonTarget as SkipButtonTarget)
      : base.skipButtonTarget,
    waveformDisplayMode: WAVEFORM_DISPLAY_MODES.has(p.waveformDisplayMode as WaveformDisplayMode)
      ? (p.waveformDisplayMode as WaveformDisplayMode)
      : base.waveformDisplayMode,
    libraryPanelCollapsed: boolOr(p.libraryPanelCollapsed, base.libraryPanelCollapsed)
  }
}
