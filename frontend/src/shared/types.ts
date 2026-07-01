// Cross-process IPC/contextBridge shapes shared by main, preload and renderer.

import type { StemQuality, VocalEnhanceStrength, DrumEnhanceStrength, BassEnhanceStrength, OtherEnhanceStrength } from './bridge/outbound'

export interface OpenedAudioFile {
  filePath: string
  fileName: string
  data: ArrayBuffer
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

  /** Delete a removed library item's generated project files (stems/samples WAVs
   *  and orphaned cover/tag media) instead of only unlinking it. */
  cleanupProjectFiles: boolean

  /** Default `targetSampleRate` for new projects; only 44 100 and 48 000 are supported. */
  defaultProjectSampleRate: number

  skipButtonTarget: SkipButtonTarget

  waveformDisplayMode: WaveformDisplayMode

  libraryPanelCollapsed: boolean
}

export type WaveformDisplayMode = 'summary' | 'stereo'

export type SkipButtonTarget = 'timelineEnds' | 'markers'

// Developer diagnostics are sampled at startup when logging, backend env, and DevTools are wired.
export interface DebugPreferences {
  loggingEnabled: boolean
  devToolsEnabled: boolean
  logDirectory: string
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
