// Cross-process data shapes shared by main, preload and renderer.
//
// Anything that crosses the IPC or contextBridge boundary lives here so the
// three TypeScript projects agree on a single definition. Renderer code can
// also access these as ambient globals (see `src/renderer/src/env.d.ts`).

/** A file opened via dialog or drag-drop and its raw decoded-able bytes. */
export interface OpenedAudioFile {
  filePath: string
  fileName: string
  /** Raw file bytes; the renderer decodes via the Web Audio API. */
  data: ArrayBuffer
}

/**
 * Normalised metadata extracted from an audio file's tags. Every field is
 * optional because different containers / tag versions populate different
 * subsets, and parsing may fail entirely.
 */
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
  /** Codec name, e.g. `'MPEG 1 Layer 3'`, `'FLAC'`, `'PCM'`. */
  codec?: string
  /** Container format, e.g. `'MPEG'`, `'FLAC'`, `'WAVE'`. */
  container?: string
  /** Average bitrate in bits per second. */
  bitrate?: number
  /** Parsed source duration in milliseconds, when the container exposes it. */
  durationMs?: number
  /** Parsed source sample rate, when available. */
  sampleRate?: number
  /** Parsed source channel count, when available. */
  channelCount?: number
  lossless?: boolean
  /** Tag types found, e.g. `['ID3v2.3']`. */
  tagTypes?: string[]
  /**
   * First embedded picture as raw bytes + mime type, if present and under
   * the size cap. The renderer wraps this in a `Blob` and exposes it via
   * `URL.createObjectURL`, then revokes the URL when the library item is
   * removed — keeping ~1–10 MB of base64 out of every persisted Pinia
   * snapshot and out of Vue's reactivity proxy.
   */
  coverArt?: {
    /** Raw image bytes (PNG / JPEG / etc.). */
    data: ArrayBuffer
    /** MIME type as reported by the tag, e.g. `'image/jpeg'`. */
    mimeType: string
  }
}

/**
 * User-visible UI state persisted across runs. Window bounds are tracked
 * separately by main and never exposed to the renderer.
 */
export interface UiPreferences {
  trackHeaderWidth: number
  libraryPanelHeight: number

  /** Continuous-follow auto-scroll during playback (default true). */
  followPlayback: boolean

  /** Show cover art / fallback thumbnails on library tiles (default true). */
  showLibraryTileImages: boolean

  /** When true, dragging a library clip onto a track auto-enables
   *  warp so the clip's source BPM matches the project BPM. Off
   *  leaves clips at native rate; the user can opt in per-clip via
   *  the right-click Warp settings dialog. Defaults to true so the
   *  conventional GarageBand-style "drop-and-play in time" behaviour
   *  works out of the box. */
  matchProjectTempoOnDrop: boolean

  /** Application default for new projects' `targetSampleRate` (Hz).
   *  Only 44 100 and 48 000 are supported today; other values snap
   *  back to 44 100 on load. Existing projects with their own stored
   *  rate are unaffected. */
  defaultProjectSampleRate: number

  /** What the transport's previous / next buttons jump to. `timelineEnds`
   *  (default) seeks the start / end of the project; `markers` steps to
   *  the previous / next timeline marker, falling back to the start / end
   *  when there's no marker in that direction. */
  skipButtonTarget: SkipButtonTarget

  /** How source waveforms are drawn. `summary` (default) shows a single
   *  mono-summed lane for every clip; `stereo` stacks separate left /
   *  right lanes for two-channel sources (mono sources still show one
   *  lane). Applies to both the timeline and the Clip Editor. */
  waveformDisplayMode: WaveformDisplayMode

  /** When true, the bottom tabbed panel (Library / Track FX / Project FX)
   *  is minimised to just its tab strip, freeing vertical space for the
   *  timeline. The tab strip stays visible so the panel can be reopened
   *  with one click. Defaults to false (expanded). */
  libraryPanelCollapsed: boolean
}

/** How source waveforms are drawn in the timeline and Clip Editor. */
export type WaveformDisplayMode = 'summary' | 'stereo'

/** Target for the transport previous / next (skip) buttons. */
export type SkipButtonTarget = 'timelineEnds' | 'markers'

/** Developer diagnostics preferences. These are sampled at startup because
 *  logging, backend environment variables, and DevTools access are wired
 *  during process/window creation. */
export interface DebugPreferences {
  /** Write main / renderer / backend logs for each session. */
  loggingEnabled: boolean
  /** Allow and expose Chromium DevTools controls. */
  devToolsEnabled: boolean
  /** Parent folder for per-session log folders. Defaults to the app directory's debug folder. */
  logDirectory: string
}
