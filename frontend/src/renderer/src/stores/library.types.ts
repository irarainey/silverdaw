// Library domain types.
//
// Shape definitions for the audio-file / saved-clip pool the renderer owns,
// plus the import-progress and peaks/channel records the library store holds.
// Extracted from `libraryStore` so the (large) type surface can be read on its
// own; `libraryStore` re-exports these so `@/stores/libraryStore` import paths
// stay stable.

import type { ClipWarpMode, LibraryItemKind } from '@shared/bridge-protocol'

export interface SavedClipSource {
  sourceItemId?: string
  sourceClipId?: string
  inMs: number
  durationMs: number
}

export interface LibraryItem {
  readonly id: string
  readonly kind: LibraryItemKind
  /** User-facing reusable name. Saved clips use this; audio files fall back to tags/fileName. */
  name?: string
  /** Source file path. Mutable because relinking a missing source
   *  re-points the item (and is refreshed from PROJECT_STATE). */
  filePath: string
  fileName: string
  /** True when the backend reports this item's source file is missing
   *  on disk (mirrors the per-item `unresolved` flag in PROJECT_STATE).
   *  Drives the Relink dialog and the missing-file prompt. */
  unresolved?: boolean
  durationMs: number
  /**
   * Sample rate of the source file. May be 0 for placeholder items
   * reconstructed from PROJECT_STATE before WAVEFORM_DATA arrives; gets
   * filled in by `setItemPeaks`.
   */
  sampleRate: number
  channelCount: number
  /**
   * Alternating min/max float pairs. `peaksPerSecond` records the actual
   * bucket rate used to create them; it can differ slightly from the
   * requested nominal rate when sample buckets must be integer-sized.
   */
  peaks: Float32Array
  peaksPerSecond?: number
  /**
   * Derived level-of-detail (LOD) peak pyramid. `peaksLod[0]` is the
   * base array (same reference as `peaks`); subsequent entries are
   * progressively coarser downsamples built once when peaks arrive,
   * so the timeline can pick a level near one peak per pixel at the
   * current zoom. Shared across every timeline clip that references
   * this library item.
   */
  peaksLod?: import('@/lib/peaksLod').PeaksLodLayer[]
  /**
   * Detected BPM (rounded to 2 d.p.) from the backend's BTrack-based
   * estimator. `undefined` until the worker job finishes. The library
   * tile shows this once it's populated.
   */
  bpm?: number
  /**
   * Beat positions in seconds from the start of the source file,
   * produced by BTrack alongside the BPM estimate. Used to draw beat
   * markers on the clip waveform and to power source-beat-aware snap
   * during drag.
   */
  beats?: number[]
  /**
   * Regression-derived phase of the ideal beat grid — the implied
   * "beat 0" time in seconds. Combined with `bpm` to lay out
   * marker positions robustly against BTrack's per-beat jitter.
   * Falls back to `beats[0]` when absent (older saved projects).
   */
  beatAnchorSec?: number
  /**
   * True when BTrack's running tempo estimate fluctuated by more
   * than ~2 % over the analysis window. The library tile shows a
   * "variable" badge so the user knows the single BPM number is a
   * rough average.
   */
  variableTempo?: boolean
  /**
   * Backend's auto-detected confidence hint. True when the BPM/beat
   * fit looked unlikely to reflect a real groove — used to default
   * non-musical samples (rain, sound effects, vocal one-shots) to
   * the `sample` classification. Recomputed on every analysis.
   */
  lowConfidence?: boolean
  /**
   * User's explicit classification override. Persisted on the item.
   * `'sample'` forces non-musical treatment (hide BPM/key/beats in
   * the library tile and clip beat markers; skip auto-warp on drop).
   * `'music'` forces musical treatment. `undefined` means "auto" —
   * the effective classification falls back to `lowConfidence`.
   * Warp and pitch shift dialogs remain available regardless so
   * samples can still be sped up / slowed down / pitch-shifted
   * manually.
   */
  sampleMode?: 'sample' | 'music'
  /** Detected musical key, stored as user-facing metadata (e.g. `C minor`). */
  key?: string
  /**
   * Path the JUCE backend should actually load when this item is placed
   * on a track. Equals `filePath` for natively-supported formats; for
   * renderer-only formats (e.g. M4A on Windows), this can point at the
   * renderer-written temp WAV.
   */
  playbackFilePath: string
  /**
   * Backend-created decoded WAV cache path, filled from
   * `LIBRARY_ITEM_ANALYSIS` or persisted project state. This is displayed
   * in the info dialog but is not sent back as `CLIP_ADD.filePath`; the
   * backend substitutes it internally from the source path.
   */
  decodedCacheFilePath?: string
  /**
   * ID3 / Vorbis / iTunes / BWF tag info, populated asynchronously by the
   * main process via `audio:readMetadata`. `undefined` while loading,
   * `null` once we know the file has no parseable tags.
   *
   * Note: the `coverArt` field of `AudioMetadata` is stripped before the
   * value lands here — the raw bytes live for one tick inside
   * `setItemMetadata`, then get wrapped in a Blob and exposed as
   * `coverArtUrl` below. Keeping the bytes out of the reactive object
   * stops Vue from proxying ~MB-sized buffers and stops Pinia devtools
   * from snapshotting them.
   */
  metadata?: AudioMetadata | null
  /**
   * `URL.createObjectURL(blob)` for the embedded cover art, if any.
   * Owned by the library store: created in `setItemMetadata`, revoked in
   * `removeItem` / `revokeItemCoverArt`. Components bind directly to it
   * as an `<img :src>` — no base64, no copying.
   */
  coverArtUrl?: string
  /** Present when this row is a reusable clip derived from another library source. */
  derivedFrom?: SavedClipSource
  /** Source-group disclosure state. True when the user has collapsed
   *  this source's saved-clip list in the library panel. Only
   *  meaningful for `audio-file` items with at least one saved-clip
   *  child. Persisted with the project. */
  collapsed?: boolean
  /** Saved-clip default warp settings. Copied onto a fresh timeline
   *  clip when the saved-clip tile is dragged in (copy-on-drop, not
   *  live link). Only meaningful when `kind === 'saved-clip'`. */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
}

/**
 * Per-file import progress entry, surfaced to the UI by the
 * `ImportProgressDialog`. An entry is created when the renderer starts
 * decoding/registering a file and removed shortly after the backend's
 * BPM detection has completed (or the import failed). The user gets a
 * visible spinner the whole time the system is working on a file —
 * including the BPM-detection stage, which used to be silent.
 */
export type ImportStage =
  | 'decoding'
  | 'detectingTempo'
  | 'detectingBeats'
  | 'warping'
  | 'done'
  | 'failed'
export interface ImportEntry {
  /** Local-only id used to remove the entry; not the library item id
   *  (which is unknown until `decoding` finishes). */
  id: string
  fileName: string
  stage: ImportStage
  /** Filled in once the library item exists; lets the BPM-arrived
   *  event match this entry by itemId. */
  libraryItemId?: string
}

/** Session-scoped high-resolution peaks for the Clip Editor (one entry at a
 *  time — each array can be multi-MB and only one editor is on screen). */
export interface EditorHiResPeaks {
  libraryItemId: string
  peaksPerSecond: number
  sampleRate: number
  peaks: Float32Array
  /** Per-channel high-res peaks `[left, right]` for stereo sources; empty for
   *  mono. Used by the Clip Editor's stereo display mode. */
  channels: Float32Array[]
}

/** Per-library-item stereo peak data: raw per-channel peaks plus a per-channel
 *  LOD pyramid so the timeline can pick a level near one peak per pixel per
 *  lane. Only populated for 2-channel sources. */
export interface ItemChannelPeaks {
  channels: Float32Array[]
  lod: import('@/lib/peaksLod').PeaksLodLayer[][]
  peaksPerSecond: number
}
