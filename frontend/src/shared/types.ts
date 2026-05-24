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
}
