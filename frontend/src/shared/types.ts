// Cross-process IPC/contextBridge shapes shared by main, preload and renderer.

import type { StemQuality, VocalEnhanceStrength, DrumEnhanceStrength, BassEnhanceStrength, OtherEnhanceStrength } from './bridge/outbound'

export interface OpenedAudioFile {
  filePath: string
  fileName: string
  data: ArrayBuffer
}

/** A Recent Projects MRU entry: the `.silverdaw` file path plus the project's
 *  display name (the project's internal name at its last save), so a renamed
 *  project shows its current name even though the file path is unchanged. */
export interface RecentProject {
  path: string
  name: string
}

/** A saved project available to the cross-project asset importer. */
export interface ProjectImportSource {
  path: string
  name: string
}

/** Normalised audio tag metadata; all fields are optional because tags vary by container. */
export interface AudioMetadata {
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  year?: number
  genre?: string[]
  trackNumber?: number
  trackTotal?: number
  discNumber?: number
  discTotal?: number
  bpm?: number
  key?: string
  composer?: string
  comment?: string
  codec?: string
  container?: string
  bitrate?: number
  durationMs?: number
  sampleRate?: number
  channelCount?: number
  lossless?: boolean
  tagTypes?: string[]
  /** Embedded cover art stays binary to avoid base64 bloat in persisted/reactive state. */
  coverArt?: {
    data: ArrayBuffer
    mimeType: string
  }
}

// User-visible UI state persisted across runs; main owns window bounds separately.
export interface UiPreferences {
  trackHeaderWidth: number
  libraryPanelHeight: number

  followPlayback: boolean

  showLibraryTileImages: boolean

  /** Auto-warp library drops to project BPM when source BPM is usable. */
  matchProjectTempoOnDrop: boolean

  /** Adopt the first dropped clip's detected tempo as the project BPM on a new project. */
  seedProjectTempoFromFirstClip: boolean

  /** After tempo analysis completes, nudge the clip so its detected beats align to
   *  the project beat grid (skips clips with no beat grid, e.g. simple samples). */
  alignClipsToGridOnAnalysis: boolean

  /** Delete a removed library item's generated project files (stems/samples WAVs
   *  and orphaned cover/tag media) instead of only unlinking it. */
  cleanupProjectFiles: boolean

  /** Default `targetSampleRate` for new projects; only 44 100 and 48 000 are supported. */
  defaultProjectSampleRate: number

  skipButtonTarget: SkipButtonTarget

  waveformDisplayMode: WaveformDisplayMode

  libraryPanelCollapsed: boolean

  /** Absolute folders the user added to the library file browser, in display order. */
  fileBrowserFolders: string[]
}

/** One row in the library file browser: a subfolder, or an importable audio file. */
export interface FileBrowserEntry {
  /** Absolute path; also the row's stable identity. */
  path: string
  /** Base name as shown in the tree. */
  name: string
  kind: 'directory' | 'file'
}

/**
 * The searchable tags held for one indexed file. Cover art is deliberately
 * absent: it is large binary data that would bloat the on-disk index for
 * something only the handful of rows actually on screen ever display.
 */
export interface FileBrowserFileTags {
  title?: string
  artist?: string
  album?: string
  durationMs?: number
}

/**
 * Everything the browser knows about one added root, gathered by a single crawl
 * and reused from then on. Rendering, expanding and filtering all read this, so
 * browsing a folder costs no disk access after the root has been indexed.
 */
export interface FileBrowserFolderIndex {
  /** The added root this index covers. */
  root: string
  /** Listing for the root and every folder beneath it, keyed by folder path. */
  folders: Record<string, FileBrowserEntry[]>
  /** Tags for every audio file beneath the root, keyed by file path. */
  tags: Record<string, FileBrowserFileTags>
  /** When the crawl ran, so a stale cache can be reported and refreshed. */
  indexedAt: number
}

/**
 * A slice of a crawl in progress, sent to the renderer as folders are listed and
 * files are tagged. Indexing a large library takes seconds, so the tree fills in
 * as the results arrive rather than staying empty until the whole root is done.
 *
 * Each message carries only what has completed since the last one, so applying
 * them in order rebuilds the same index the crawl finally returns.
 */
export interface FileBrowserIndexProgress {
  /** The added root being crawled. */
  root: string
  /** Folder listings completed since the previous message. */
  folders: Record<string, FileBrowserEntry[]>
  /** File tags read since the previous message. */
  tags: Record<string, FileBrowserFileTags>
  /** Audio files found under the root so far. */
  fileCount: number
  /** Files whose tags have been read so far, so progress can be shown as a ratio. */
  taggedCount: number
  /** True once the whole root has been listed, so only tag reads remain. */
  listed: boolean
}

export type WaveformDisplayMode = 'summary' | 'stereo'
export type SkipButtonTarget = 'timelineEnds' | 'markers'

// Developer diagnostics are sampled at startup when logging, backend env, and DevTools are wired.
export interface DebugPreferences {
  loggingEnabled: boolean
  devToolsEnabled: boolean
  logDirectory: string
}

export interface MidiDeckSelection {
  deck1Enabled: boolean
  deck2Enabled: boolean
}

export type MidiCrossfaderDirection = 'leftToRight' | 'rightToLeft'

/** Which deck a device auto-selects at startup when it has no saved cue selection. */
export type MidiDefaultDeck = 'none' | 'deck1' | 'deck2'

export interface MidiDevicePreferences {
  scrubAudioEnabled: boolean
  crossfaderDirection: MidiCrossfaderDirection
  defaultDeck: MidiDefaultDeck
}

export const DEFAULT_MIDI_DEVICE_PREFERENCES: Readonly<MidiDevicePreferences> = {
  scrubAudioEnabled: false,
  crossfaderDirection: 'leftToRight',
  defaultDeck: 'none'
}

// ─── Stem-separation model store (download-on-first-use) ──────────────────────

/** Fast presence summary for the stem-separation model, returned to the renderer. */
export interface StemModelState {
  installed: boolean
  presentBytes: number
  totalBytes: number
  fileCount: number
}

/** Per-tick progress while the ~1.2 GB model is fetched, pushed main → renderer. */
export interface StemModelDownloadProgress {
  receivedBytes: number
  totalBytes: number
  fileName: string
  fileIndex: number
  fileCount: number
}

/** Outcome of an `ensureStemModel` request. */
export type EnsureStemModelResult =
  | { ok: true }
  | { ok: false; error: string; fileName?: string }

/** GPU availability for stem separation, detected in the main process. */
export interface StemGpuStatus {
  /** True when a hardware GPU (not a software / basic-render adapter) is present. */
  available: boolean
  /** Human-readable adapter name when known, else null. */
  name: string | null
}

/** Persisted stem-separation preferences surfaced to the renderer. */
export interface StemPrefsDto {
  useGpu: boolean
  quality: StemQuality
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

/** Persisted turntable-brake defaults surfaced to the renderer (preset names). */
export type BrakeDurationDto = 'short' | 'medium' | 'long'
export type BrakeCurveDto = 'linear' | 'curved' | 'steep'
export interface BrakePrefsDto {
  duration: BrakeDurationDto
  curve: BrakeCurveDto
}

/** Persisted turntable-backspin defaults surfaced to the renderer (preset names). */
export type BackspinDurationDto = 'short' | 'medium' | 'long'
export type BackspinIntensityDto = 'gentle' | 'medium' | 'wild'
export interface BackspinPrefsDto {
  duration: BackspinDurationDto
  intensity: BackspinIntensityDto
}

/** Persisted Scratch Editor realism preference surfaced to the renderer. */
export type ScratchRealismLevelDto = 'off' | 'medium' | 'high'
export interface ScratchRealismPrefsDto {
  level: ScratchRealismLevelDto
}

/** Persisted Scratch Editor input preferences surfaced to the renderer. */
export type ScratchCrossfaderCutKeyDto = 'KeyZ' | 'KeyM'
export interface ScratchPrefsDto {
  crossfaderCutKey: ScratchCrossfaderCutKeyDto
}

/** Where the stem model lives and whether it is a user-located copy. */
export interface StemModelInfo {
  /** Directory the backend loads the ONNX sessions from. */
  directory: string
  /** True when the directory is a user-supplied override (locate flow). */
  located: boolean
  /** True when every model file is present at its expected size. */
  installed: boolean
}

/** Outcome of a `locateStemModel` request. */
export type LocateStemModelResult =
  | { ok: true; directory: string }
  | { ok: false; error: string }
