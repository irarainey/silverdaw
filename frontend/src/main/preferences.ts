import { app } from 'electron'
import { join, resolve as pathResolve } from 'node:path'
import type { DebugPreferences, RecentProject, SkipButtonTarget, WaveformDisplayMode } from '../shared/types'
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
  /** Seed the project tempo from the first clip dropped on a new project. */
  seedProjectTempoFromFirstClip: boolean
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
  /**
   * Optional override directories pointing at user-supplied / manually-placed
   * copies of the RoFormer quality packs (the per-pack "locate" flow). Empty /
   * undefined means the app-managed download location is used.
   */
  vocalPackDir?: string
  rhythmPackDir?: string
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
  // The MIT RoFormer quality packs (Vocal + Rhythm) are the primary separation
  // engine and are used automatically whenever they are installed. htdemucs is
  // the BACKUP, used per stem only when that stem's pack is absent. Set this to
  // force the htdemucs backup for every stem even when the packs are installed
  // (e.g. for speed or troubleshooting). Default off.
  useBackupModel: boolean
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

// Per-device keep-awake is a simple on/off toggle stored per output device (keyed by the
// device's reported name). Default off: a device is kept awake only when explicitly enabled —
// and the toggle is remembered even while the device is unplugged, so it re-applies on
// reconnect. When on, the backend runs the keep-alive dither + first-play wake so a sleep-prone
// USB output does not clip the first beat.

// Turntable-brake effect defaults (a global app preference). Stored as named
// presets; the renderer maps them to the numeric platter-stop time + rate-curve
// power it pushes to the backend and draws on the timeline.
export type BrakeDuration = 'short' | 'medium' | 'long'
export type BrakeCurve = 'linear' | 'curved' | 'steep'
export interface BrakePrefs {
  duration: BrakeDuration
  curve: BrakeCurve
}

// Turntable-backspin effect defaults (a global app preference). Duration + the
// spin intensity (peak reverse speed); the curve is fixed in the renderer.
export type BackspinDuration = 'short' | 'medium' | 'long'
export type BackspinIntensity = 'gentle' | 'medium' | 'wild'
export interface BackspinPrefs {
  duration: BackspinDuration
  intensity: BackspinIntensity
}

export interface Preferences {
  window: WindowPrefs
  ui: UiPrefs
  debug: DebugPrefs
  toasts: ToastPrefs
  paths: PathPrefs
  autosave: AutosavePrefs
  audioOutput: AudioOutputPrefs
  /** Per-device keep-awake toggles, keyed by device name; absent / false = off. */
  keepAwakeByDevice: Record<string, boolean>
  brake: BrakePrefs
  backspin: BackspinPrefs
  stems: StemPrefs
  /** MRU entries (path + display name), newest first, capped and case-insensitive by path. */
  recentProjects: RecentProject[]
}

export const MAX_RECENT_PROJECTS = 10
export const AUTOSAVE_MIN_SECONDS = 5
export const AUTOSAVE_MAX_SECONDS = 600
export const AUTOSAVE_DEFAULT_SECONDS = 30

// `app.getPath` is only safe after `app.whenReady`, so defaults are lazy.
export function getDefaultDebugLogDirectory(): string {
  // Packaged installs run from a read-only WindowsApps (MSIX) directory, so the
  // default log location must be a per-user writable path (userData). Dev builds
  // keep logs in the repo tree for convenience.
  return app.isPackaged
    ? join(app.getPath('userData'), 'debug')
    : join(pathResolve(__dirname, '..', '..', '..'), 'debug')
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
      seedProjectTempoFromFirstClip: true,
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
    keepAwakeByDevice: {},
    brake: { duration: 'medium', curve: 'curved' },
    backspin: { duration: 'long', intensity: 'medium' },
    stems: {
      useGpu: false,
      quality: 'balanced',
      useBackupModel: false,
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

/** The user-facing project name derived from a `.silverdaw` file path — the file
 *  name without the extension. Used as the fallback display name for legacy or
 *  nameless recent entries. */
export function recentNameFromPath(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  const base = lastSep >= 0 ? path.slice(lastSep + 1) : path
  return base.replace(/\.silverdaw$/i, '')
}

export function sanitiseRecentList(input: unknown): RecentProject[] {
  if (!Array.isArray(input)) return []
  const out: RecentProject[] = []
  const seen = new Set<string>()
  for (const value of input) {
    // Accept both the legacy string-path form and the {path,name} object form.
    let path: string | undefined
    let name: string | undefined
    if (typeof value === 'string') {
      path = value
    } else if (value && typeof value === 'object') {
      const candidate = value as { path?: unknown; name?: unknown }
      if (typeof candidate.path === 'string') path = candidate.path
      if (typeof candidate.name === 'string') name = candidate.name
    }
    if (path === undefined) continue
    const trimmedPath = path.trim()
    if (trimmedPath.length === 0) continue
    const key = trimmedPath.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const trimmedName = name?.trim()
    out.push({
      path: trimmedPath,
      name: trimmedName && trimmedName.length > 0 ? trimmedName : recentNameFromPath(trimmedPath)
    })
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
    useBackupModel: boolOr(p.useBackupModel, base.useBackupModel),
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

const BRAKE_DURATIONS: ReadonlySet<BrakeDuration> = new Set(['short', 'medium', 'long'])
const BRAKE_CURVES: ReadonlySet<BrakeCurve> = new Set(['linear', 'curved', 'steep'])

// Single source of truth for brake-prefs validation; a partial `prefs:setBrake`
// update or a corrupt prefs file can never inject a wrong-typed value.
export function sanitiseBrakePrefs(partial: unknown, base: BrakePrefs): BrakePrefs {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Partial<Record<keyof BrakePrefs, unknown>>
  return {
    duration: BRAKE_DURATIONS.has(p.duration as BrakeDuration) ? (p.duration as BrakeDuration) : base.duration,
    curve: BRAKE_CURVES.has(p.curve as BrakeCurve) ? (p.curve as BrakeCurve) : base.curve
  }
}

const BACKSPIN_DURATIONS: ReadonlySet<BackspinDuration> = new Set(['short', 'medium', 'long'])
const BACKSPIN_INTENSITIES: ReadonlySet<BackspinIntensity> = new Set(['gentle', 'medium', 'wild'])

// Single source of truth for backspin-prefs validation.
export function sanitiseBackspinPrefs(partial: unknown, base: BackspinPrefs): BackspinPrefs {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Partial<Record<keyof BackspinPrefs, unknown>>
  return {
    duration: BACKSPIN_DURATIONS.has(p.duration as BackspinDuration) ? (p.duration as BackspinDuration) : base.duration,
    intensity: BACKSPIN_INTENSITIES.has(p.intensity as BackspinIntensity) ? (p.intensity as BackspinIntensity) : base.intensity
  }
}

// Single source of truth for the per-device keep-awake map. Only non-empty device names
// that are explicitly enabled (value === true) are kept — off is the default, so `false` /
// absent entries are dropped and a corrupt prefs file can never inject a wrong-typed value.
export function sanitiseKeepAwakeByDevice(input: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!input || typeof input !== 'object') return out
  for (const [name, enabled] of Object.entries(input as Record<string, unknown>)) {
    const trimmed = name.trim()
    if (trimmed.length === 0) continue
    if (enabled === true) out[trimmed] = true
  }
  return out
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
    seedProjectTempoFromFirstClip: boolOr(p.seedProjectTempoFromFirstClip, base.seedProjectTempoFromFirstClip),
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
